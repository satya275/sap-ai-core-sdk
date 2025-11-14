import cds, { INSERT, SELECT } from '@sap/cds';

export type ConversationEntity = cds.ModelEntity<any>;
export type MessageEntity = cds.ModelEntity<any>;

export type MemoryMessage = {
  role: string;
  content: string;
};

export async function handleMemoryBeforeRagCall(
  conversationId: string,
  messageId: string,
  messageTime: string,
  userId: string,
  userQuery: string,
  Conversation: ConversationEntity,
  Message: MessageEntity
): Promise<MemoryMessage[]> {
  const tx = cds.transaction();

  const conversation = await tx.run(
    SELECT.one.from(Conversation).where({ cID: conversationId })
  );

  if (!conversation) {
    await tx.run(
      INSERT.into(Conversation).entries({
        cID: conversationId,
        userId
      })
    );
  }

  const resolvedMessageId = messageId ?? cds.utils.uuid();
  await tx.run(
    INSERT.into(Message).entries({
      mID: resolvedMessageId,
      cID_cID: conversationId,
      role: 'user',
      content: userQuery,
      creation_time: messageTime
    })
  );

  const history = await tx.run(
    SELECT.from(Message)
      .columns('role', 'content')
      .where({ cID_cID: conversationId })
      .orderBy('creation_time asc')
  );

  return (history ?? [])
    .filter((entry: any) => entry?.role && entry?.content)
    .map((entry: any) => ({
      role: entry.role as string,
      content: entry.content as string
    }));
}

export async function handleMemoryAfterRagCall(
  conversationId: string,
  responseTimestamp: string,
  completion: { role: string; content: string; additionalContents?: any[] },
  Message: MessageEntity,
  Conversation: ConversationEntity
): Promise<string | undefined> {
  const tx = cds.transaction();

  const conversationExists = await tx.run(
    SELECT.one.from(Conversation).where({ cID: conversationId })
  );

  if (!conversationExists) {
    await tx.run(
      INSERT.into(Conversation).entries({
        cID: conversationId,
        userId: ''
      })
    );
  }

  const inserted = await tx.run(
    INSERT.into(Message).entries({
      cID_cID: conversationId,
      role: completion.role,
      content: completion.content,
      creation_time: responseTimestamp
    })
  );

  return inserted?.mID;
}
