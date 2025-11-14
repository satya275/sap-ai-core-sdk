import cds from '@sap/cds';
import { executeHttpRequest } from '@sap-cloud-sdk/http-client';

const AUTH_HEADER =
  cds.env.requires?.SUCCESS_FACTORS_CREDENTIALS?.AUTHORIZATION_HEADER;

interface PdfStatusResponse {
  status: string;
  message: string;
}

interface CustomerAnalyticsQuery {
  orderDirection: 'asc' | 'desc';
  rankingType: 'top' | 'bottom';
  limit: number;
  clientFilter: string;
  hasCrossLob: boolean;
  limitProvided: boolean;
}

interface CustomerInsight {
  position: number;
  customerName: string;
  averageCustomerPaymentDays: number | null;
  raw: Record<string, any>;
}

interface PdfValidationResult extends PdfStatusResponse {
  companyCode?: string;
  fiscalYear?: string;
  formattedDate?: string;
}

const DATASPHERE_CUSTOMER_PATH =
  'api/v1/datasphere/consumption/relational/GROUP_IT_SAP/4GV_FF_S_FI_OTCKPI_01/_4GV_FF_S_FI_OTCKPI_01';

const log = cds.log('chatbot');

function extractXmlValue(xmlString: unknown, tagName: string): string {
  if (!xmlString) {
    return '';
  }
  const text =
    typeof xmlString === 'string'
      ? xmlString
      : (xmlString as any)?.toString?.() ?? '';
  const regex = new RegExp(`<d:${tagName}>([\\s\\S]*?)<\\/d:${tagName}>`, 'i');
  const match = regex.exec(text);
  return match ? match[1].trim() : '';
}

function parsePdfStatusResponse(rawPayload: unknown): PdfStatusResponse {
  let payload = rawPayload as any;

  if (Buffer.isBuffer(payload)) {
    payload = payload.toString('utf8');
  }

  const normalizeJsonPayload = (data: any): PdfStatusResponse => {
    const node = data?.d ?? data;
    return {
      status: node?.EStatus || node?.status || '',
      message: node?.EStatusMessage || node?.message || ''
    };
  };

  if (payload && typeof payload === 'object') {
    const { status, message } = normalizeJsonPayload(payload);
    if (status) {
      return { status, message };
    }
  }

  if (typeof payload === 'string') {
    const trimmedPayload = payload.trim();
    if (trimmedPayload.startsWith('{') || trimmedPayload.startsWith('[')) {
      try {
        const parsedJson = JSON.parse(trimmedPayload);
        const { status, message } = normalizeJsonPayload(parsedJson);
        if (status) {
          return { status, message };
        }
      } catch (error) {
        log?.warn?.('Failed to parse invoice status JSON payload', error);
      }
    }

    const status = extractXmlValue(trimmedPayload, 'EStatus');
    const message = extractXmlValue(trimmedPayload, 'EStatusMessage');
    if (status) {
      return { status, message };
    }
    return {
      status: 'E',
      message: message || 'Unable to process the validation response.'
    };
  }

  return {
    status: 'E',
    message: 'Unable to process the validation response.'
  };
}

function normalizeDateToYyyymmdd(asOfDate: unknown): string {
  if (!asOfDate && asOfDate !== 0) {
    return '';
  }
  const rawValue = `${asOfDate}`.trim();
  if (!rawValue) {
    return '';
  }

  const sanitizedValue = rawValue
    .replace(/\\s*([-.\/])\\s*/g, '$1')
    .replace(/\\s{2,}/g, ' ')
    .trim();

  if (/^\\d{8}$/.test(sanitizedValue)) {
    return sanitizedValue;
  }

  if (/^\\d{4}[-\/.]\\d{2}[-\/.]\\d{2}$/.test(sanitizedValue)) {
    return sanitizedValue.replace(/[-./]/g, '');
  }

  if (/^\\d{2}[-\/.]\\d{2}[-\/.]\\d{4}$/.test(sanitizedValue)) {
    const parts = sanitizedValue.split(/[-.\/]/);
    const [day, month, year] = parts;
    return `${year}${month}${day}`;
  }

  if (/^\\d{2}[-\/.][A-Za-z]{3}[-\/.]\\d{4}$/.test(sanitizedValue)) {
    const parsedDate = new Date(sanitizedValue);
    if (!Number.isNaN(parsedDate.getTime())) {
      const year = parsedDate.getFullYear();
      const month = String(parsedDate.getMonth() + 1).padStart(2, '0');
      const day = String(parsedDate.getDate()).padStart(2, '0');
      return `${year}${month}${day}`;
    }
    return '';
  }

  const parsedDate = new Date(sanitizedValue);
  if (!Number.isNaN(parsedDate.getTime())) {
    const year = parsedDate.getFullYear();
    const month = String(parsedDate.getMonth() + 1).padStart(2, '0');
    const day = String(parsedDate.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }

  if (/^\\d{8}$/.test(rawValue)) {
    return rawValue;
  }

  return '';
}

function parseCustomerAnalyticsQuery(analyticsQuery: unknown): CustomerAnalyticsQuery {
  const queryText = (analyticsQuery ?? '').toString().trim();

  const isBottomQuery = /(bottom|worst|bad|delayed)/i.test(queryText);
  const rankingType = isBottomQuery ? 'bottom' : 'top';
  const orderDirection = isBottomQuery ? 'desc' : 'asc';

  let limit = 5;
  const explicitTopMatch = queryText.match(
    /(?:top|bottom|best|worst|bad|delayed|on\\s*-?time)\\s*(\\d{1,3})/i
  );
  const numericMentionMatch = queryText.match(/(\\d{1,3})\\s*customers?/i);
  const limitMatch = explicitTopMatch || numericMentionMatch;
  const limitProvided = Boolean(limitMatch);
  if (limitMatch) {
    const parsedLimit = parseInt(limitMatch[1], 10);
    if (!Number.isNaN(parsedLimit) && parsedLimit > 0) {
      limit = parsedLimit;
    }
  }

  const hasCrossLob =
    /(cross[-\\s]*lob|across\\s+all\\s+(?:lines?\\s+of\\s+business|lobs?)|across\\s+lobs?)/i.test(
      queryText
    );
  let clientFilter = 'Aerospace 288';
  if (hasCrossLob) {
    clientFilter = '';
  } else if (/(\\belect\\b|electronics?\\s*288)/i.test(queryText)) {
    clientFilter = 'Electronics 288';
  } else if (/aero/i.test(queryText)) {
    clientFilter = 'Aerospace 288';
  }

  return {
    orderDirection,
    rankingType,
    limit,
    clientFilter,
    hasCrossLob,
    limitProvided
  };
}

function buildDatasphereQuery({
  orderDirection,
  limit,
  clientFilter
}: CustomerAnalyticsQuery): string {
  const queryParts: string[] = [];
  if (clientFilter) {
    queryParts.push(
      `$filter=${encodeURIComponent(`Client eq '${clientFilter}'`)}`
    );
  }
  queryParts.push(
    `$orderby=${encodeURIComponent(`Average_Customer_Payment_Days ${orderDirection}`)}`
  );
  queryParts.push('$count=true');
  queryParts.push(`$top=${limit}`);
  queryParts.push('$skip=0');

  return `${DATASPHERE_CUSTOMER_PATH}?${queryParts.join('&')}`;
}

function extractCustomerInsights(data: any): CustomerInsight[] {
  const records = Array.isArray(data?.value)
    ? data.value
    : Array.isArray(data?.d?.results)
    ? data.d.results
    : Array.isArray(data)
    ? data
    : [];

  return records.map((entry: any, index: number) => {
    const customerName =
      entry?.CustomerName ||
      entry?.Customer ||
      entry?.Customer_Name ||
      entry?.CUSTOMER ||
      entry?.CustomerDescription ||
      'Unknown Customer';
    const paymentDays =
      entry?.Average_Customer_Payment_Days ??
      entry?.AverageCustomerPaymentDays ??
      entry?.AvgPaymentDays ??
      entry?.AveragePaymentDays ??
      entry?.Averagecustomerpaymentdays ??
      null;

    return {
      position: index + 1,
      customerName,
      averageCustomerPaymentDays:
        paymentDays === undefined ? null : (paymentDays as number | null),
      raw: entry
    };
  });
}

export async function getCustomerDataFromDatasphere(
  analyticsQuery: string
): Promise<{
  data: any;
  formattedURL: string;
  appliedParameters: CustomerAnalyticsQuery;
  analysis: {
    summary: string;
    scopeDescription: string;
    rankingDescription: string;
    rankingType: string;
    orderDirection: string;
    limit: number;
    clientFilter: string;
    limitProvided: boolean;
    customerInsights: CustomerInsight[];
    customerHighlights: string[];
  };
}> {
  const queryDetails = parseCustomerAnalyticsQuery(analyticsQuery);
  const formattedURL = buildDatasphereQuery(queryDetails);
  try {
    log.info?.('getCustomerDataFromDatasphere formattedURL', formattedURL);
    const response = await executeHttpRequest(
      {
        destinationName: 'datasphere_ap11_qas'
      },
      {
        method: 'GET',
        url: formattedURL
      }
    );
    log.info?.(
      'getCustomerDataFromDatasphere status',
      (response as any)?.status
    );
    log.debug?.(
      'getCustomerDataFromDatasphere data',
      JSON.stringify((response as any)?.data)
    );

    const customerInsights = extractCustomerInsights((response as any)?.data);
    const customerHighlights = customerInsights.map(item => {
      const paymentText =
        item.averageCustomerPaymentDays === null ||
        item.averageCustomerPaymentDays === undefined
          ? 'N/A'
          : `${item.averageCustomerPaymentDays} days`;
      return `${item.position}. ${item.customerName} - ${paymentText}`;
    });
    const scopeDescription = queryDetails.clientFilter
      ? `within the ${queryDetails.clientFilter} client`
      : 'across all lines of business';
    const rankingDescription = `${queryDetails.rankingType} ${queryDetails.limit}`;
    const customerWord = queryDetails.limit === 1 ? 'customer' : 'customers';
    const limitNote = queryDetails.limitProvided
      ? ''
      : ' (defaulted to 5 due to unspecified limit)';
    const summary = `Analyzed the ${rankingDescription} ${customerWord}${limitNote} ${scopeDescription} based on Average Customer Payment Days.`;

    return {
      data: (response as any)?.data,
      formattedURL,
      appliedParameters: queryDetails,
      analysis: {
        summary,
        scopeDescription,
        rankingDescription,
        rankingType: queryDetails.rankingType,
        orderDirection: queryDetails.orderDirection,
        limit: queryDetails.limit,
        clientFilter: queryDetails.clientFilter,
        limitProvided: queryDetails.limitProvided,
        customerInsights,
        customerHighlights
      }
    };
  } catch (error) {
    log.error?.('getCustomerDataFromDatasphere error', error);
    throw error;
  }
}

export async function getDownloadlink(
  invoiceNumber: string
): Promise<{ downloadUrl: string }> {
  const trimmedInvoice = (invoiceNumber ?? '').toString().trim();

  let formattedURL = '';

  if (trimmedInvoice.length >= 5) {
    const fiscalYearPrefix = trimmedInvoice.substring(1, 3);
    const fiscalYear = `20${fiscalYearPrefix}`;
    const companyCode = trimmedInvoice.substring(3, 6);
    const docNumber = `${trimmedInvoice}`;

    formattedURL = `/sap/opu/odata/sap/ZFI_OTC_FORM_INVOICE_PDF_SRV/get_pdfSet(IBlart='RI',ICompany='${companyCode}',IDocno='${docNumber}',IFiscalYear='${fiscalYear}',ISystemAlias='AERO288')/$value`;
  }
  try {
    log.info?.('getDownloadlink formattedURL', formattedURL);
    await executeHttpRequest(
      {
        destinationName: 'sthubsystem-qa-new'
      },
      {
        method: 'GET',
        url: formattedURL,
        responseType: 'arraybuffer'
      }
    );
  } catch (error) {
    log.error?.('getDownloadlink error', error);
  }

  return { downloadUrl: formattedURL };
}

export async function validateInvoiceAvailability(
  invoiceNumber: string
): Promise<PdfValidationResult> {
  const trimmedInvoice = (invoiceNumber ?? '').toString().trim();
  if (!trimmedInvoice) {
    return { status: '', message: '', companyCode: '', fiscalYear: '' };
  }

  if (trimmedInvoice.length < 6) {
    return {
      status: 'E',
      message: 'Unable to derive the required details from the provided invoice number.',
      companyCode: '',
      fiscalYear: ''
    };
  }

  const fiscalYearPrefix = trimmedInvoice.substring(1, 3);
  const fiscalYear = `20${fiscalYearPrefix}`;
  const companyCode = trimmedInvoice.substring(3, 6);
  const docNumber = `${trimmedInvoice}`;

  const formattedURL = `/sap/opu/odata/sap/ZFI_OTC_FORM_INVOICE_PDF_SRV/get_pdfstatusSet(IBlart='RI',ICompany='${companyCode}',IDocno='${docNumber}',IFiscalYear='${fiscalYear}',ISystemAlias='AERO288')`;

  try {
    log.info?.('validateInvoiceAvailability request', formattedURL);
    const response = await executeHttpRequest(
      {
        destinationName: 'sthubsystem-qa-new'
      },
      {
        method: 'GET',
        url: formattedURL,
        responseType: 'text'
      }
    );
    log.info?.('validateInvoiceAvailability status', (response as any)?.status);
    if ((response as any)?.data !== undefined) {
      log.debug?.('validateInvoiceAvailability body', (response as any).data);
    }
    const parsed = parsePdfStatusResponse((response as any)?.data);
    return {
      status: parsed.status,
      message: parsed.message,
      companyCode,
      fiscalYear
    };
  } catch (error) {
    log.error?.('validateInvoiceAvailability error', error);
    return {
      status: 'E',
      message:
        'Unable to validate the invoice number at this time. Please try again later.',
      companyCode,
      fiscalYear
    };
  }
}

export async function getStatementOfAccountLink(
  companyCode: string,
  customerCode: string,
  asOfDate: string
): Promise<{ downloadUrl: string; formattedDate: string }> {
  const trimmedCompanyCode = (companyCode ?? '').toString().trim();
  const trimmedCustomerCode = (customerCode ?? '').toString().trim();
  const formattedDate = normalizeDateToYyyymmdd(asOfDate);

  let formattedURL = '';

  if (trimmedCompanyCode && trimmedCustomerCode && formattedDate) {
    formattedURL = `/sap/opu/odata/sap/ZFI_AR_SOA_FORM_SRV/get_pdfSet(ICompany='${trimmedCompanyCode}',ICustomer='${trimmedCustomerCode}',IOpendate='${formattedDate}',ISystemAlias='AERO288')/$value`;
    try {
      log.info?.('getStatementOfAccountLink formattedURL', formattedURL);
      await executeHttpRequest(
        {
          destinationName: 'sthubsystem-qa-new'
        },
        {
          method: 'GET',
          url: formattedURL,
          responseType: 'arraybuffer'
        }
      );
    } catch (error) {
      log.error?.('getStatementOfAccountLink error', error);
    }
  }

  return { downloadUrl: formattedURL, formattedDate };
}

export async function validateStatementOfAccount(
  companyCode: string,
  customerCode: string,
  asOfDate: string
): Promise<PdfValidationResult> {
  const trimmedCompanyCode = (companyCode ?? '').toString().trim();
  const trimmedCustomerCode = (customerCode ?? '').toString().trim();
  const formattedDate = normalizeDateToYyyymmdd(asOfDate);

  if (!trimmedCompanyCode || !trimmedCustomerCode || !formattedDate) {
    return {
      status: '',
      message: '',
      formattedDate
    };
  }

  const formattedURL = `/sap/opu/odata/sap/ZFI_AR_SOA_FORM_SRV/get_pdfstatusSet(ICompany='${trimmedCompanyCode}',ICustomer='${trimmedCustomerCode}',IOpendate='${formattedDate}',ISystemAlias='AERO288')`;

  try {
    const response = await executeHttpRequest(
      {
        destinationName: 'sthubsystem-qa-new'
      },
      {
        method: 'GET',
        url: formattedURL,
        responseType: 'text'
      }
    );
    const parsed = parsePdfStatusResponse((response as any)?.data);
    return {
      status: parsed.status,
      message: parsed.message,
      formattedDate
    };
  } catch (error) {
    log.error?.('validateStatementOfAccount error', error);
    return {
      status: 'E',
      message:
        'Unable to validate the provided customer details at this time. Please try again later.',
      formattedDate
    };
  }
}

export async function getUserInfoById(filterQuery: string): Promise<any[]> {
  try {
    const formattedURL = `/sap/opu/odata/sap/ZFI_OTC_CREDITNOTE_SRV;mo/GetInvoiceSearchResult?sap-client=888&${filterQuery}&SAP__Origin='AERO288'&skip=0&top=5&$format=json`;
    log.info?.('getUserInfoById formattedURL', formattedURL);
    const response = await executeHttpRequest(
      {
        destinationName: 'sthubsystem-qa-new'
      },
      {
        method: 'GET',
        url: formattedURL,
        data: {}
      }
    );
    const results = (response as any)?.data?.d?.results;
    log.info?.('getUserInfoById count', results?.length ?? 0);
    return Array.isArray(results) ? results : [];
  } catch (error) {
    log.error?.('getUserInfoById error', error);
    return [];
  }
}

async function getUserInfoByIdLegacy(userId: string): Promise<any> {
  try {
    const destination = await cds.connect.to('sthubsystem-qa');
    return await destination.send({
      query:
        "GET /sap/opu/odata/sap/ZFI_OTC_CREDITNOTE_SRV;mo/GetInvoiceSearchResult?sap-client=888&InvoiceNo=''&InvoiceType='FI'&FiscalYear='2024'&DateFrom=''&DateTo=''&SalesOrder=''&CompanyCode='801'&SAP__Origin='AERO288'?$format=json",
      headers: { Authorization: AUTH_HEADER }
    });
  } catch (error) {
    log.error?.('getUserInfoByIdLegacy error', error);
    return null;
  }
}

export async function getUserManagerId(
  userId: string
): Promise<string | null> {
  try {
    const destination = await cds.connect.to('destination_sf');
    const result = await destination.send({
      query: `GET /odata/v2/User('${userId}')/manager?$format=json`,
      headers: { Authorization: AUTH_HEADER }
    });
    return result?.d?.userId ?? null;
  } catch (error) {
    log.error?.('getUserManagerId error', error);
    return null;
  }
}

export async function getDirectReportsById(
  userId: string
): Promise<Array<{ userId: string; displayName: string }>> {
  try {
    const destination = await cds.connect.to('destination_sf');
    const result = await destination.send({
      query: `GET /odata/v2/User?$filter=manager/userId eq '${userId}'&$format=JSON`,
      headers: { Authorization: AUTH_HEADER }
    });

    if (Array.isArray(result?.d?.results)) {
      return result.d.results.map((item: any) => ({
        userId: item.userId,
        displayName: item.displayName
      }));
    }
    return [];
  } catch (error) {
    log.error?.('getDirectReportsById error', error);
    return [];
  }
}

export async function getEmployeeTime(
  userId: string,
  displayName: string,
  startDate: string,
  endDate: string,
  approvalStatus = 'CANCELLED',
  approvalStatusOperator: 'eq' | 'ne' = 'ne',
  timeType = 'TT_VAC_REC'
): Promise<
  | {
      userId: string;
      displayName: string;
      vacations: Array<{ startDate: string; endDate: string }>;
    }
  | null
> {
  try {
    const destination = await cds.connect.to('destination_sf');
    const result = await destination.send({
      query: `GET /odata/v2/EmployeeTime?&$format=json&$filter=userId eq '${userId}' and approvalStatus ${approvalStatusOperator} '${approvalStatus}' and startDate gt datetime'${startDate}' and endDate lt datetime'${endDate}' and timeType eq '${timeType}'`,
      headers: { Authorization: AUTH_HEADER }
    });

    if (Array.isArray(result?.d?.results)) {
      const response = {
        userId,
        displayName,
        vacations: [] as Array<{ startDate: string; endDate: string }>
      };

      for (const vacation of result.d.results) {
        const start = vacation.startDate?.substr?.(6, vacation.startDate.length - 8);
        const end = vacation.endDate?.substr?.(6, vacation.endDate.length - 8);
        if (start && end) {
          response.vacations.push({ startDate: start, endDate: end });
        }
      }
      return response;
    }
    return null;
  } catch (error) {
    log.error?.('getEmployeeTime error', error);
    return null;
  }
}

export async function getPeersVacationTimeByUserId(
  userId: string,
  startDate: string,
  endDate: string,
  noOfDatesToExtend: number,
  approvalStatus = 'CANCELLED',
  approvalStatusOperator: 'eq' | 'ne' = 'ne',
  timeType = 'TT_VAC_REC'
): Promise<
  Array<
    | {
        userId: string;
        displayName: string;
        vacations: Array<{ startDate: string; endDate: string }>;
      }
    | null
  >
> {
  const managerId = await getUserManagerId(userId);
  if (!managerId) {
    return [];
  }
  const peers = await getDirectReportsById(managerId);

  const start = new Date(Date.parse(startDate));
  start.setDate(start.getDate() - noOfDatesToExtend);
  const endDt = new Date(Date.parse(endDate));
  endDt.setDate(endDt.getDate() + noOfDatesToExtend);

  const startDateLc = timestampToString(start.getTime());
  const endDateLc = timestampToString(endDt.getTime());

  const results: Array<
    | {
        userId: string;
        displayName: string;
        vacations: Array<{ startDate: string; endDate: string }>;
      }
    | null
  > = [];

  for (const peer of peers) {
    const timeObj = await getEmployeeTime(
      peer.userId,
      peer.displayName,
      startDateLc,
      endDateLc,
      approvalStatus,
      approvalStatusOperator,
      timeType
    );
    results.push(timeObj);
  }

  return results;
}

export function timestampToString(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

export const __private = {
  extractXmlValue,
  parsePdfStatusResponse,
  normalizeDateToYyyymmdd,
  parseCustomerAnalyticsQuery,
  buildDatasphereQuery,
  extractCustomerInsights,
  getUserInfoByIdLegacy
};
