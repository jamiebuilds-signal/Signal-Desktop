// Copyright 2024 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import type { WritableDB } from '../../sql/Interface.std.ts';
import { sql } from '../../sql/util.std.ts';
import { createDB, updateToVersion, explain } from './helpers.node.ts';

describe('SQL/updateToSchemaVersion1100', () => {
  let db: WritableDB;
  beforeEach(() => {
    db = createDB();
    updateToVersion(db, 1100);
  });

  afterEach(() => {
    db.close();
  });

  describe('Optimize markAllCallHistoryReadInConversation', () => {
    it('uses index for marking call history read in conversation', () => {
      // Mirrors the UPDATE in markAllCallHistoryRead(db, target, true)
      const details = explain(
        db,
        sql`
          UPDATE messages
          SET
            readStatus = 0,
            seenStatus = 2,
            json = json_patch(json, '{}')
          WHERE messages.type IS 'call-history'
            AND messages.conversationId IS 'test-conversation'
            AND messages.seenStatus IS 1
            AND messages.received_at <= 123;
        `
      );

      assert.strictEqual(
        details,
        'SEARCH messages USING INDEX messages_callHistory_markReadByConversationBefore (type=? AND conversationId=? AND seenStatus=?)'
      );
    });
  });
});
