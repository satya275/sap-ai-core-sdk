import cds, { DELETE, INSERT, SELECT } from '@sap/cds';
import { AzureOpenAiEmbeddingClient } from '@sap-ai-sdk/foundation-models';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { PDFDocument } from 'pdf-lib';
import { PDFLoader } from 'langchain/document_loaders/fs/pdf';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';

function array2VectorBuffer(data: number[]): Buffer {
  const sizeFloat = 4;
  const sizeDimensions = 4;
  const buffer = Buffer.allocUnsafe(data.length * sizeFloat + sizeDimensions);
  buffer.writeUInt32LE(data.length, 0);
  data.forEach((v, i) =>
    buffer.writeFloatLE(v, i * sizeFloat + sizeDimensions)
  );
  return buffer;
}

async function toBufferFromStream(readable: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function toBufferAny(x: any): Promise<Buffer> {
  if (!x) {
    throw new Error('PDF content is empty');
  }

  if (Buffer.isBuffer(x)) {
    return x;
  }

  if (x instanceof Readable || (x && typeof x.on === 'function')) {
    return await toBufferFromStream(x as Readable);
  }

  if (x && typeof x.read === 'function') {
    const out = await x.read();
    return toBufferAny(out);
  }

  if (ArrayBuffer.isView(x)) {
    return Buffer.from(x.buffer, x.byteOffset ?? 0, x.byteLength);
  }

  if (x instanceof ArrayBuffer) {
    return Buffer.from(x);
  }

  if (typeof x === 'string') {
    try {
      return Buffer.from(x, 'base64');
    } catch {
      return Buffer.from(x, 'binary');
    }
  }

  if (typeof x === 'object') {
    if (Array.isArray((x as any).data)) {
      return Buffer.from((x as any).data);
    }
    if ((x as any).value != null) {
      return toBufferAny((x as any).value);
    }
    if ((x as any).buffer && typeof (x as any).byteLength === 'number') {
      return Buffer.from(
        (x as any).buffer,
        (x as any).byteOffset ?? 0,
        (x as any).byteLength
      );
    }
  }

  throw new Error(
    `Unsupported content type for PDF: ${Object.prototype.toString.call(x)}`
  );
}

function deleteIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      console.error('Error deleting temp file:', error);
    }
  }
}

function normalizeForPrompt(t: string): string {
  if (!t) {
    return '';
  }
  return String(t)
    .replace(/^[\s]*(?:Q:|A:)\s*/gim, '')
    .replace(/^[\s]*(?:LINK_SOURCE|SOURCE|FILE|DOC_ID)\s*=\s*.*$/gim, '')
    .replace(/^[\s]*Page\s+\d+\s+of\s+\d+[\s]*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function createEmbeddingClient(): AzureOpenAiEmbeddingClient {
  const cfg = cds.env.requires?.GENERATIVE_AI_HUB ?? {};
  const modelName = cfg.EMBEDDING_MODEL_NAME ?? 'text-embedding-3-small';
  const resourceGroup = cfg.EMBEDDING_MODEL_RESOURCE_GROUP;
  const deploymentId = cfg.EMBEDDING_MODEL_DEPLOYMENT_ID;
  const destinationName = cfg.EMBEDDING_MODEL_DESTINATION_NAME;

  if (!deploymentId && !modelName) {
    throw new Error(
      'Missing embedding configuration: specify model name or deployment ID.'
    );
  }

  const deployment = deploymentId
    ? { deploymentId, resourceGroup }
    : { modelName, resourceGroup };

  const destination = destinationName ? { destinationName } : undefined;

  return new AzureOpenAiEmbeddingClient(deployment as any, destination);
}

export async function storeEmbeddings(uuid: string): Promise<string> {
  let tempDocLocation: string | undefined;
  try {
    const DB = await cds.connect.to('db');
    const DocumentChunks =
      cds.model.definitions['ChatbotService.DocumentChunks'];
    const Files = cds.model.definitions['ChatbotService.Files'];

    if (!Files) {
      throw new Error('Files entity is not available in the CDS model.');
    }

    const fileRow = await DB.run(
      SELECT.one.from(Files).columns('fileName', 'content').where({ ID: uuid })
    );

    if (!fileRow || fileRow.content == null) {
      throw new Error(`Document with uuid ${uuid} not found or empty.`);
    }

    const pdfBytes = await toBufferAny(fileRow.content);

    const header = Buffer.from(pdfBytes.slice(0, 4)).toString('ascii');
    if (header !== '%PDF') {
      throw new Error('Content is not a valid PDF (missing %PDF header).');
    }

    const safeName = (fileRow.fileName || `${uuid}.pdf`).replace(/[\W]+/g, '_');
    tempDocLocation = path.join('/tmp', safeName);
    fs.writeFileSync(tempDocLocation, pdfBytes);

    const externalPdfDoc = await PDFDocument.load(pdfBytes);
    const pdfDoc = await PDFDocument.create();
    const pages = await pdfDoc.copyPages(
      externalPdfDoc,
      externalPdfDoc.getPageIndices()
    );
    pages.forEach(page => pdfDoc.addPage(page));
    fs.writeFileSync(tempDocLocation, await pdfDoc.save());

    await cds.transaction().run(DELETE.from(DocumentChunks));

    const loader = new PDFLoader(tempDocLocation);
    const documents = await loader.load();
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1500,
      chunkOverlap: 150,
      addStartIndex: true
    });
    const textChunks = await splitter.splitDocuments(documents);

    const embeddingClient = createEmbeddingClient();

    const entries: any[] = [];
    for (const chunk of textChunks) {
      const cleaned = normalizeForPrompt(chunk.pageContent);
      if (!cleaned || cleaned.length < 10) {
        continue;
      }
      const response = await embeddingClient.run({ input: cleaned });
      const vector = response.getEmbedding();
      if (!vector?.length) {
        throw new Error('Embedding response does not contain vector data.');
      }
      entries.push({
        ID: cds.utils.uuid(),
        text_chunk: cleaned,
        metadata_column: fileRow.fileName,
        embedding: array2VectorBuffer(vector),
        original_documentId: uuid
      });
    }

    const BATCH = 200;
    for (let i = 0; i < entries.length; i += BATCH) {
      await INSERT.into(DocumentChunks).entries(entries.slice(i, i + BATCH));
    }

    return 'Embeddings stored successfully!';
  } catch (error: any) {
    console.error(
      'Error while generating and storing vector embeddings:',
      error
    );
    throw error;
  } finally {
    if (tempDocLocation) {
      deleteIfExists(tempDocLocation);
    }
  }
}

export async function deleteEmbeddings(): Promise<string> {
  try {
    const DocumentChunks =
      cds.model.definitions['ChatbotService.DocumentChunks'];
    await cds.transaction().run(DELETE.from(DocumentChunks));
    return 'Success!';
  } catch (error: any) {
    console.error('Error while deleting the embeddings content in db:', error);
    throw error;
  }
}
