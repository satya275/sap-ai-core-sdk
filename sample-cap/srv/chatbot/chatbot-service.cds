@path: 'chatbot'
@requires: 'any'
service ChatbotService {
  action getChatRagResponse(
    conversationId : UUID,
    messageId      : UUID,
    message_time   : Timestamp,
    user_id        : String,
    user_query     : String
  ) returns ChatMessage;

  action deleteChatData() returns String;
  action storeEmbeddings(uuid : UUID) returns String;
  action deleteEmbeddings() returns String;
}

type ChatMessage {
  role              : String;
  content           : String;
  messageTime       : Timestamp;
  messageId         : UUID;
  additionalContents: array of AdditionalContent;
}

type AdditionalContent {
  type : String;
  data : large String;
}

entity Conversations : managed {
  key cID : UUID;
  userId  : String;
}

entity Messages : managed {
  key mID      : UUID;
  cID          : Association to Conversations;
  role         : String;
  content      : large String;
  creation_time: Timestamp;
}

entity DocumentChunks : managed {
  key ID             : UUID;
  text_chunk         : large String;
  metadata_column    : String;
  embedding          : LargeBinary;
  original_documentId: UUID;
}

entity Files : managed {
  key ID       : UUID;
  fileName     : String;
  content      : LargeBinary;
  contentType  : String;
  size         : Integer64;
}
