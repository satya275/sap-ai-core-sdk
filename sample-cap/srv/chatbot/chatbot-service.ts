import cds, { DELETE, SELECT } from '@sap/cds';
import { AzureOpenAiChatClient } from '@sap-ai-sdk/foundation-models';
import {
  deleteEmbeddings as deleteEmbeddingsFromStore,
  storeEmbeddings as storeEmbeddingsInVectorStore,
  createEmbeddingClient
} from './embedding-storage';
import {
  handleMemoryAfterRagCall,
  handleMemoryBeforeRagCall
} from './memory-helper';
import {
  getCustomerDataFromDatasphere,
  getDownloadlink,
  getStatementOfAccountLink,
  getUserInfoById,
  validateInvoiceAvailability,
  validateStatementOfAccount
} from './sf-connection-util';

const embeddingColumn = 'embedding';
const contentColumn = 'text_chunk';

function normalizeInvoiceNumber(rawValue?: string): string {
  if (rawValue === undefined || rawValue === null) {
    return '';
  }
  const digitsOnly = `${rawValue}`.replace(/\D/g, '').trim();
  if (!digitsOnly) {
    return '';
  }
  const truncated = digitsOnly.length > 10 ? digitsOnly.slice(-10) : digitsOnly;
  return truncated.padStart(10, '0');
}

function extractInvoiceNumberFromText(text?: string): string {
  if (!text) {
    return '';
  }
  const matches = `${text}`.match(/\d+/g);
  if (!matches || matches.length === 0) {
    return '';
  }
  matches.sort((a, b) => b.length - a.length);
  return matches[0] || '';
}

const systemPrompt = `Your task is to classify the user question into either of the four categories: invoice-request-query, download-invoice, customer-analytics or generic-query


 If the user wants to know the invoice related details with company code, invoice number, posting date ,Customer return the response as json
 with the following format:
 {
    "category" : "invoice-request-query"
    "query: "InvoiceNo='AccountingDocument'&InvoiceType='FI'&FiscalYear='year of invoice posting date'&DateFrom='fromDate'&DateTo='toDate'&SalesOrder=''&CompanyCode='companyCode'"
 }


 If the user wants to download, print or get a link for an invoice provide the response as json
 with the following format:
 {
    "category" : "download-invoice",
    "invoiceNumber" : "invoice digits provided by the user (never leave empty when digits are present)"
 }


 If the user wants to retrieve a Statement of Account (SOA) for a customer provide the response as json
 with the following format:
 {
    "category" : "soa-request",
    "companyCode" : "company code provided by the user",
    "customerCode" : "customer code provided by the user",
    "asOfDate" : "as-of date provided by the user in any recognizable date format"
 }


 For all other queries, return the response as json as follows
 {
    "category" : "generic-query"
 }


 If the user is asking about customer analytics, historical customer performance, payment history, or requests insight such as best or worst customers, return the response as json
 with the following format:
 {
    "category" : "customer-analytics",
    "analyticsQuery": "<restated customer analytics question from the user>"
 }


Rules:


1. If the user does not provide any invoice related information consider it as a generic category.
2. If the category of the user question is "invoice-request-query",
a. if the user does not input exact dates and only mentions year, fill the dates as "[start date of the year]-[end date of the year]".
b. if the user does not input exact dates and only mentions months, fill the dates as "[start date of the month]-[end date of the month]".
c. if the user does not input exact dates and only mentions week, fill the dates as "[start date of the week]-[end date of the week]".


3. If the category of the user question is "download-invoice",
a. always include the invoice number digits supplied by the user. You may add leading zeros to make it ten digits, but never omit the digits entirely.
b. if the user input includes any digits that could represent an invoice number, return those digits (even if fewer than ten) so the service can normalize them; only respond with an empty invoiceNumber when no digits are present.
c. Treat common misspellings of the word invoice (for example: inovice, invioce, invice) as referring to invoices when interpreting the user request.


4. If the category of the user question is "soa-request",
a. if the user does not provide the company code, customer code, or as-of date, set the respective value as an empty string in the response JSON.
b. Capture the as-of date exactly as provided by the user.


EXAMPLES:


EXAMPLE1:


user input: What kind of invoice details can provide ?
response:  {
    "category" : "generic-query"
 }




EXAMPLE2:


user input: Can get invoices between January 1 to January 10 and company code 898?
response:  {
    "category" : "invoice-request-query"
    "query: "InvoiceNo=''&InvoiceType='FI'&FiscalYear='2024'&DateFrom='01.01.2024'&DateTo='10.01.2024'&SalesOrder=''&CompanyCode='898'"
}


EXAMPLE3:


user input:  Can I get invoices posted in in March 2024for company code 801 ?
response:  {
    "category" : "invoice-request-query"
    "query: "InvoiceNo=''&InvoiceType='FI'&FiscalYear='2024'&DateFrom='01.03.2024'&DateTo='31.03.2024'&SalesOrder=''&CompanyCode='801'"
 }


EXAMPLE4:


user input:  Can I get invoices posted or created this week ?


If user provides company code as 803 then
response:  {
    "category" : "invoice-request-query"
    "query: "InvoiceNo=''&InvoiceType='FI'&FiscalYear='2024'&DateFrom='17.04.2024'&DateTo='24.04.2024'&SalesOrder=''&CompanyCode='803'"
 }


Rules: \n
1. Ask follow up questions for company code  \n

 EXAMPLE5:


 user input:  Can I get invoices posted or created this year under 808 comapny code?
 response:  {
     "category" : "invoice-request-query"
     "query: "InvoiceNo=''&InvoiceType='FI'&FiscalYear='2024'&DateFrom='01.01.2024'&DateTo='31.12.2024'&SalesOrder=''&CompanyCode='808'"
    }


Rules: \n
If the invoice search list {} or empty or undefined , then instruct the user to provide revised search criteria.\n





EXAMPLE6:


user input:  Can I get invoices posted or created last year ?
ask for follow up question on company code and feed user input company code in query.


Rules: \n
1. Ask follow up questions for company code  \n
if the user proivdes 898 \n


response:  {
    "category" : "invoice-request-query"
    "query: "InvoiceNo=''&InvoiceType='FI'&FiscalYear='2023'&DateFrom='01.01.2023'&DateTo='31.12.2023'&SalesOrder=''&CompanyCode='898'"
}


EXAMPLE8:
user input:  Can I get invoice details for invoice 248013075?
response:  {
    "category" : "invoice-request-query"
    "query: "InvoiceNo='0248013075'&InvoiceType='FI'&FiscalYear='2024'&DateFrom=''&DateTo=''&SalesOrder=''&CompanyCode='801'"
}
Rules: \n
1. Ask follow up questions if you need additional  \n
2. make InvoiceNo as 10 digit example in this case 0248013075 \n
3. in this invoiceNo , year will be 24 ( first two chars) which is 2024, company code wil be 801 (char 3 + char 4 +char 5) \n



EXAMPLE9:
user input: Can get invoice search policy ?
response: {
    "category" : "generic-query"
 }


EXAMPLE10:


user input: Please share the download link for invoice 248013029.
response: {
    "category" : "download-invoice"
    "invoiceNumber" : "0248013029"
}


EXAMPLE10A:


user input: Download invoice 123425231.
response: {
    "category" : "download-invoice"
    "invoiceNumber" : "123425231"
}


EXAMPLE11:


user input: I need to download the invoice copy.
response: {
    "category" : "download-invoice"
    "invoiceNumber" : ""
}



EXAMPLE12:


user input: Who has been our best customer in terms of revenue over the last quarter?
response:  {
    "category" : "customer-analytics",
    "analyticsQuery" : "Who has been our best customer in terms of revenue over the last quarter?"
 }


EXAMPLE13:


user input: Show me the payment history details for our top five customers.
response:  {
    "category" : "customer-analytics",
    "analyticsQuery" : "Show me the payment history details for our top five customers."
 }


EXAMPLE14:


user input: Please share the SOA for customer 100252 in company code 808 as of 2nd May 2017.
response:  {
    "category" : "soa-request",
    "companyCode" : "808",
    "customerCode" : "100252",
    "asOfDate" : "2nd May 2017"
 }
`;

const hrRequestPrompt = `You are a chatbot. Answer the user question based on the following information

1. Invoice search policy , delimited by triple backticks. \n 
2. If there are any invoice specific invoice detetais guidelies in the Invoice Policy , Consider the invoice details and check the invoice search list .\n

Invoice search list details \n

{ 

Example object for invoice details : it should return in ths example format only. rules
remove any special symbols (*,_ etc) generate nice specified format only.
Invoice 1:
Invoice Number: "AccountingDocument" // 248013000
Document Date: "DocumentDate" // 02.01.2024
Posting Date: "PostingDate" // 02.01.2024
Customer: "Customer" // A200007-00
Currency: "Currency"//SGD
Reference Document: "ReferenceDocument"//DA8012312B001176 
}
Invoice 2:
Invoice Number: 248013000
Document Date: 02.01.2024
Posting Date: 02.01.2024
Customer: A200007-00
Currency: SGD
Reference Document: DA8012312B001176 
}
...

\n

Rules: \n 
1. Ask follow up questions if you need additional information from user to answer the question.\n 
2. If the invoice search list {} or empty or undefined , then instruct the user to provide optimized search criteria.\n
3. Note that invoice and AccountDocument are alias names , always return response as invoice \n
4. Be more formal in your response. \n
5. Keep the answers concise. \n
6. Alwasy return some response with proper instructions to user. \n
`;

const genericRequestPrompt =
  'You are a chatbot. Answer the user question based only on the context, delimited by triple backticks\n ';

const downloadRequestPrompt = `You are a chatbot. Use the provided context, delimited by triple backticks, to support invoice download requests.\n
Context includes:\n
1. invoiceNumber\n
2. downloadUrl\n
3. EStatus\n
4. EStatusMessage\n
Rules:\n
1. If invoiceNumber is empty ask the user to kindly provide the invoice number required for the download.\n
2. If EStatus equals 'E', respond using exactly the text in EStatusMessage with no additional commentary.\n
3. When EStatus equals 'S' and downloadUrl is available, respond using exactly the following XML structure with no additional text or punctuation:\n
<href>{invoiceNumber}</href>\n\n<href-value>{downloadUrl}</href-value>\n
4. Keep the tone formal and concise.\n`;

const soaRequestPrompt = `You are a chatbot. Use the provided context, delimited by triple backticks, to support Statement of Account (SOA) requests.\n
Context includes:\n
1. companyCode\n
2. customerCode\n
3. asOfDate\n
4. formattedDate\n
5. downloadUrl\n
6. EStatus\n
7. EStatusMessage\n
Rules:\n
1. If any of companyCode, customerCode, or formattedDate is empty, politely ask the user to provide the missing information.\n
2. If EStatus equals 'E', respond using exactly the text in EStatusMessage with no additional commentary.\n
3. When all required details are present, EStatus equals 'S', and downloadUrl is available, respond using exactly the following XML structure with no additional text or punctuation:\n
<href>StatementOfAccount</href>\n\n<href-value>{downloadUrl}</href-value>\n
4. Keep the tone formal and concise.\n`;

const customerAnalyticsPrompt = `You are a chatbot. Use the provided context, delimited by triple backticks, to answer customer analytics questions.\n
Context includes:\n
1. The original customer analytics question.\n
2. Customer analytics data retrieved from the Datasphere service.\n
Rules:\n
1. Summarize the returned analytics data in a clear and concise manner.\n
2. If the data is empty, inform the user that no customer analytics data is available and suggest refining the question.\n
3. Keep the tone formal and professional.\n`;

const taskCategory: Record<string, string> = {
  'invoice-request-query': hrRequestPrompt,
  'generic-query': genericRequestPrompt,
  'download-invoice': downloadRequestPrompt,
  'customer-analytics': customerAnalyticsPrompt,
  'soa-request': soaRequestPrompt
};

const CHAT_COMPLETION_MODEL = process.env.CHATBOT_COMPLETION_MODEL ?? 'gpt-4o';
const CLASSIFICATION_MODEL =
  process.env.CHATBOT_CLASSIFICATION_MODEL ?? 'gpt-4o-mini';
const TOP_K = Number(process.env.CHATBOT_RAG_TOP_K ?? '5');

function parseEmbedding(buffer: Buffer): number[] {
  if (!buffer?.length) {
    return [];
  }
  const view = Buffer.from(buffer);
  const dimension = view.readUInt32LE(0);
  const values: number[] = [];
  for (let i = 0; i < dimension; i++) {
    values.push(view.readFloatLE(4 + i * 4));
  }
  return values;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function buildContextFromEmbeddings(
  queryEmbedding: number[]
): Promise<string> {
  const DocumentChunks = cds.model.definitions['ChatbotService.DocumentChunks'];
  if (!DocumentChunks) {
    return '';
  }
  const rows = await SELECT.from(DocumentChunks).columns(
    contentColumn,
    embeddingColumn
  );
  if (!Array.isArray(rows) || !rows.length) {
    return '';
  }
  const scored = rows
    .map((row: any) => ({
      text: row[contentColumn] as string,
      embedding: parseEmbedding(row[embeddingColumn] as Buffer)
    }))
    .filter(entry => entry.text && entry.embedding.length)
    .map(entry => ({
      text: entry.text,
      score: cosineSimilarity(queryEmbedding, entry.embedding)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K)
    .map(entry => entry.text);

  return scored.join('\n---\n');
}

export default class ChatbotService {
  async getChatRagResponse(req: any): Promise<any> {
    try {
      const { conversationId, messageId, message_time, user_id, user_query } =
        req.data;
      const { Conversations: Conversation, Messages: Message } = this.entities;

      const classificationClient = new AzureOpenAiChatClient(
        CLASSIFICATION_MODEL
      );

      const determinationPayload = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: user_query }
      ];

      const determinationResponse = await classificationClient.run({
        messages: determinationPayload,
        temperature: 0,
        top_p: 0
      });

      const determinationContent = determinationResponse.getContent();
      const determinationJson = JSON.parse(determinationContent ?? '{}');
      const category = determinationJson?.category;

      cds.log('chatbot').info('classification', {
        query: user_query,
        classification: determinationJson
      });

      if (!taskCategory.hasOwnProperty(category)) {
        throw new Error(`${category} is not in the supported categories.`);
      }

      const promptResponses: Record<string, string> = {
        'invoice-request-query': hrRequestPrompt,
        'generic-query': genericRequestPrompt,
        'download-invoice': downloadRequestPrompt,
        'customer-analytics': customerAnalyticsPrompt,
        'soa-request': soaRequestPrompt
      };

      let deterministicResponse: {
        role: string;
        content: string;
        additionalContents: any[];
      } | null = null;

      if (category === 'invoice-request-query') {
        const filterQuery = determinationJson?.query;
        if (filterQuery) {
          const dataInvoiceList = await getUserInfoById(filterQuery);
          const teamLeaveDataString = JSON.stringify(dataInvoiceList);
          promptResponses['invoice-request-query'] =
            hrRequestPrompt + ` \`\`${teamLeaveDataString}\`\` \n`;
        }
      }

      if (category === 'download-invoice') {
        const inferredInvoiceDigits = extractInvoiceNumberFromText(user_query);
        const inferredInvoiceNumber = normalizeInvoiceNumber(
          inferredInvoiceDigits
        );
        const classifierInvoiceNumber = normalizeInvoiceNumber(
          determinationJson?.invoiceNumber
        );

        let invoiceNumber = '';
        if (inferredInvoiceNumber) {
          invoiceNumber = inferredInvoiceNumber;
        } else if (classifierInvoiceNumber) {
          invoiceNumber = classifierInvoiceNumber;
        }

        let EStatus = '';
        let EStatusMessage = '';
        let downloadUrl = '';

        if (invoiceNumber) {
          const precheckResponse =
            await validateInvoiceAvailability(invoiceNumber);
          cds
            .log('chatbot')
            .info('validateInvoiceAvailability', precheckResponse);
          EStatus = precheckResponse?.status || '';
          EStatusMessage = precheckResponse?.message || '';
          if (EStatus === 'S') {
            const downloadLinkResponse = await getDownloadlink(invoiceNumber);
            downloadUrl =
              downloadLinkResponse?.downloadUrl ||
              downloadLinkResponse?.url ||
              '';
          }
        }

        const downloadContext = {
          invoiceNumber,
          downloadUrl,
          EStatus,
          EStatusMessage
        };
        cds.log('chatbot').info('download-invoice context', downloadContext);

        if (!invoiceNumber) {
          deterministicResponse = {
            role: 'assistant',
            content:
              'Kindly provide the invoice number required for the download.',
            additionalContents: []
          };
        } else if (EStatus === 'E') {
          deterministicResponse = {
            role: 'assistant',
            content: EStatusMessage || 'Invoice not found.',
            additionalContents: []
          };
        } else if (EStatus === 'S' && downloadUrl) {
          deterministicResponse = {
            role: 'assistant',
            content: `<href>${invoiceNumber}</href>\n\n<href-value>${downloadUrl}</href-value>`,
            additionalContents: []
          };
        } else {
          deterministicResponse = {
            role: 'assistant',
            content:
              'Invoice download service is temporarily unavailable. Please try again in a few minutes.',
            additionalContents: []
          };
        }

        promptResponses['download-invoice'] =
          downloadRequestPrompt +
          ` \`\`${JSON.stringify(downloadContext)}\`\` \n`;
      }

      if (category === 'soa-request') {
        const companyCode = determinationJson?.companyCode
          ? `${determinationJson.companyCode}`.trim()
          : '';
        const customerCode = determinationJson?.customerCode
          ? `${determinationJson.customerCode}`.trim()
          : '';
        const asOfDate = determinationJson?.asOfDate
          ? `${determinationJson.asOfDate}`.trim()
          : '';

        let downloadUrl = '';
        let formattedDate = '';
        let EStatus = '';
        let EStatusMessage = '';

        if (companyCode && customerCode && asOfDate) {
          const precheckResponse = await validateStatementOfAccount(
            companyCode,
            customerCode,
            asOfDate
          );
          formattedDate = precheckResponse?.formattedDate || '';
          EStatus = precheckResponse?.status || '';
          EStatusMessage = precheckResponse?.message || '';

          if (EStatus === 'S') {
            const soaLinkResponse = await getStatementOfAccountLink(
              companyCode,
              customerCode,
              asOfDate
            );
            formattedDate = soaLinkResponse?.formattedDate || formattedDate;
            downloadUrl = soaLinkResponse?.downloadUrl || '';
          }
        }

        const soaContext = {
          companyCode,
          customerCode,
          asOfDate,
          formattedDate,
          downloadUrl,
          EStatus,
          EStatusMessage
        };
        promptResponses['soa-request'] =
          soaRequestPrompt + ` \`\`${JSON.stringify(soaContext)}\`\` \n`;
      }

      if (category === 'customer-analytics') {
        const analyticsQuery = determinationJson?.analyticsQuery || user_query;
        try {
          const customerAnalyticsResult =
            await getCustomerDataFromDatasphere(analyticsQuery);
          cds
            .log('chatbot')
            .info('customer analytics response', customerAnalyticsResult);
          const analyticsContext = {
            analyticsQuery,
            serviceResponse: customerAnalyticsResult?.data,
            serviceUrl: customerAnalyticsResult?.formattedURL,
            appliedParameters: customerAnalyticsResult?.appliedParameters,
            analysis: customerAnalyticsResult?.analysis
          };
          promptResponses['customer-analytics'] =
            customerAnalyticsPrompt +
            ` \`\`${JSON.stringify(analyticsContext)}\`\` \n`;
        } catch (error) {
          cds.log('chatbot').error('customer analytics service call', error);
          const analyticsContext = {
            analyticsQuery,
            serviceResponse: [],
            serviceUrl: '',
            appliedParameters: {},
            analysis: {
              summary: '',
              scopeDescription: '',
              rankingDescription: '',
              rankingType: '',
              orderDirection: '',
              limit: 0,
              clientFilter: '',
              limitProvided: false,
              customerInsights: [],
              customerHighlights: []
            }
          };
          promptResponses['customer-analytics'] =
            customerAnalyticsPrompt +
            ` \`\`${JSON.stringify(analyticsContext)}\`\` \n`;
        }
      }

      const memoryContext = await handleMemoryBeforeRagCall(
        conversationId,
        messageId,
        message_time,
        user_id,
        user_query,
        Conversation,
        Message
      );

      if (deterministicResponse) {
        const responseTimestamp = new Date().toISOString();
        await handleMemoryAfterRagCall(
          conversationId,
          responseTimestamp,
          deterministicResponse,
          Message,
          Conversation
        );

        const persistedResponseMessage = await SELECT.one.from(Message).where({
          cID_cID: conversationId,
          creation_time: responseTimestamp,
          role: deterministicResponse.role
        });

        return {
          role: deterministicResponse.role,
          content: deterministicResponse.content,
          messageTime: responseTimestamp,
          messageId: persistedResponseMessage?.mID,
          additionalContents: deterministicResponse.additionalContents
        };
      }

      const embeddingClient = createEmbeddingClient();
      const embeddingResponse = await embeddingClient.run({
        input: user_query
      });
      const queryEmbedding = embeddingResponse.getEmbedding();
      const retrievedContext = queryEmbedding
        ? await buildContextFromEmbeddings(queryEmbedding)
        : '';

      if (retrievedContext) {
        promptResponses[category] += ` Context:\n\`\`${retrievedContext}\`\``;
      }

      const chatClient = new AzureOpenAiChatClient(CHAT_COMPLETION_MODEL);
      const historyMessages = memoryContext.slice(0, -1);
      const messages = [
        { role: 'system', content: promptResponses[category] },
        ...historyMessages,
        { role: 'user', content: user_query }
      ];

      const chatResponse = await chatClient.run({
        messages,
        temperature: 0.2
      });

      const responseTimestamp = new Date().toISOString();
      const completion = {
        role: 'assistant',
        content: chatResponse.getContent(),
        additionalContents: [] as any[]
      };

      await handleMemoryAfterRagCall(
        conversationId,
        responseTimestamp,
        completion,
        Message,
        Conversation
      );

      const persistedResponseMessage = await SELECT.one.from(Message).where({
        cID_cID: conversationId,
        creation_time: responseTimestamp,
        role: completion.role
      });

      return {
        role: completion.role,
        content: completion.content,
        messageTime: responseTimestamp,
        messageId: persistedResponseMessage?.mID,
        additionalContents: completion.additionalContents
      };
    } catch (error: any) {
      cds.log('chatbot').error('Error generating response', error);
      throw error;
    }
  }

  async deleteChatData(): Promise<string> {
    try {
      const { Conversations: Conversation, Messages: Message } = this.entities;
      await DELETE.from(Message);
      await DELETE.from(Conversation);
      return 'Success!';
    } catch (error: any) {
      cds.log('chatbot').error('Error deleting the chat content in db', error);
      throw error;
    }
  }

  async storeEmbeddings(req: any): Promise<string> {
    const { uuid } = req.data;
    return storeEmbeddingsInVectorStore(uuid);
  }

  async deleteEmbeddings(): Promise<string> {
    return deleteEmbeddingsFromStore();
  }
}
