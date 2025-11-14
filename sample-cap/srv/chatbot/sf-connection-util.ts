import cds from '@sap/cds';

const SERVICE_CONFIG = cds.env.requires?.SUCCESS_FACTORS_SERVICE;
const SERVICE_NAME =
  typeof SERVICE_CONFIG === 'string'
    ? SERVICE_CONFIG
    : (SERVICE_CONFIG?.name ?? 'success-factors');

async function invokeRemote(action: string, payload: any): Promise<any> {
  try {
    const service = await cds.connect.to(SERVICE_NAME);
    const handler = (service as any)[action];
    if (typeof handler === 'function') {
      return handler.call(service, payload);
    }
    if (typeof (service as any).send === 'function') {
      return (service as any).send(action, payload);
    }
  } catch (error) {
    cds
      .log('chatbot')
      .warn(
        `Falling back to default response for ${action}: ${(error as Error).message}`
      );
  }
  return undefined;
}

export async function getUserInfoById(filterQuery: string): Promise<any[]> {
  const response = await invokeRemote('getUserInfoById', { filterQuery });
  if (Array.isArray(response)) {
    return response;
  }
  return [];
}

export async function validateInvoiceAvailability(
  invoiceNumber: string
): Promise<{ status?: string; message?: string }> {
  const response = await invokeRemote('validateInvoiceAvailability', {
    invoiceNumber
  });
  if (response && typeof response === 'object') {
    return response as { status?: string; message?: string };
  }
  return {};
}

export async function getDownloadlink(
  invoiceNumber: string
): Promise<{ downloadUrl?: string; url?: string }> {
  const response = await invokeRemote('getDownloadlink', { invoiceNumber });
  if (response && typeof response === 'object') {
    return response as { downloadUrl?: string; url?: string };
  }
  return {};
}

export async function validateStatementOfAccount(
  companyCode: string,
  customerCode: string,
  asOfDate: string
): Promise<{ status?: string; message?: string; formattedDate?: string }> {
  const response = await invokeRemote('validateStatementOfAccount', {
    companyCode,
    customerCode,
    asOfDate
  });
  if (response && typeof response === 'object') {
    return response as {
      status?: string;
      message?: string;
      formattedDate?: string;
    };
  }
  return {};
}

export async function getStatementOfAccountLink(
  companyCode: string,
  customerCode: string,
  asOfDate: string
): Promise<{ downloadUrl?: string; formattedDate?: string }> {
  const response = await invokeRemote('getStatementOfAccountLink', {
    companyCode,
    customerCode,
    asOfDate
  });
  if (response && typeof response === 'object') {
    return response as {
      downloadUrl?: string;
      formattedDate?: string;
    };
  }
  return {};
}

export async function getCustomerDataFromDatasphere(
  analyticsQuery: string
): Promise<any> {
  const response = await invokeRemote('getCustomerDataFromDatasphere', {
    analyticsQuery
  });
  if (response && typeof response === 'object') {
    return response;
  }
  return {
    data: [],
    formattedURL: '',
    appliedParameters: {},
    analysis: {}
  };
}
