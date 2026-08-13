import type { DbOperation, LocalDatabase } from '../platform/database.js';
import { executeOperation, nowIso, runOperation, runTransaction } from './database.js';

export interface MigrationContext {
  trigramFts: boolean;
}

export interface Migration {
  version: number;
  name: string;
  operations: (context: MigrationContext) => DbOperation[];
}

const script = (sql: string) => (_context: MigrationContext): DbOperation[] => [executeOperation(sql)];
const tokenizer = (context: MigrationContext) => context.trigramFts ? 'trigram' : 'unicode61 remove_diacritics 2';

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    operations: script(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL DEFAULT 'main',
        role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        seq INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('pending','sending','sent','failed')),
        client_msg_id TEXT,
        reply_to TEXT,
        error TEXT,
        meta_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE UNIQUE INDEX idx_messages_seq ON messages(conversation_id, seq);
      CREATE INDEX idx_messages_created ON messages(conversation_id, created_at DESC);
      CREATE UNIQUE INDEX idx_messages_client ON messages(conversation_id, client_msg_id) WHERE client_msg_id IS NOT NULL;

      CREATE TABLE media (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('image','audio','sticker','file')),
        rel_path TEXT NOT NULL,
        mime TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        duration REAL,
        origin TEXT NOT NULL CHECK (origin IN ('upload','generated','builtin','remote')),
        created_at TEXT NOT NULL,
        transcript TEXT,
        meta_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_media_created ON media(created_at DESC);
      CREATE INDEX idx_media_sha ON media(sha256);

      CREATE TABLE message_parts (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('text','sticker','image','audio','file','system')),
        text TEXT,
        media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('pending','sent','failed')),
        error TEXT,
        duration REAL,
        transcript TEXT,
        meta_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_parts_message ON message_parts(message_id, idx);
      CREATE INDEX idx_parts_media ON message_parts(media_id);

      CREATE TABLE stickers (
        id TEXT PRIMARY KEY,
        media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        emotion TEXT NOT NULL DEFAULT 'neutral',
        use_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_stickers_emotion ON stickers(emotion, enabled);

      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('profile','preference','relationship','project','event','summary')),
        content TEXT NOT NULL,
        normalized TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        confidence REAL NOT NULL DEFAULT 0.6,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        hits INTEGER NOT NULL DEFAULT 0,
        embedding BLOB,
        embedding_dim INTEGER,
        embedding_model TEXT,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX idx_memories_kind ON memories(kind, active);
      CREATE UNIQUE INDEX idx_memories_norm ON memories(normalized) WHERE active = 1;

      CREATE TABLE memory_sources (
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (memory_id, message_id)
      );

      CREATE VIRTUAL TABLE memories_fts USING fts5(
        content,
        content='memories',
        content_rowid='rowid',
        tokenize="unicode61 remove_diacritics 2"
      );
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TABLE summaries (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL DEFAULT 'main',
        version INTEGER NOT NULL,
        from_seq INTEGER NOT NULL,
        to_seq INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        model TEXT,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX idx_summaries_range ON summaries(conversation_id, from_seq, to_seq);

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        run_after TEXT
      );
      CREATE INDEX idx_jobs_status ON jobs(status, run_after);

      CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE events (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX idx_events_seq ON events(seq);
      CREATE INDEX idx_events_created ON events(created_at);
      CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO counters(name, value) VALUES ('message_seq', 0), ('event_seq', 0);
    `)
  },
  {
    version: 2,
    name: 'error_log',
    operations: script(`
      CREATE TABLE error_log (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, scope TEXT NOT NULL, message TEXT NOT NULL, detail TEXT);
      CREATE INDEX idx_error_created ON error_log(created_at DESC);
    `)
  },
  {
    version: 3,
    name: 'fts_trigram_tokenizer',
    operations: (context) => [executeOperation(`
      DROP TRIGGER IF EXISTS memories_ai;
      DROP TRIGGER IF EXISTS memories_ad;
      DROP TRIGGER IF EXISTS memories_au;
      DROP TABLE IF EXISTS memories_fts;
      CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='rowid', tokenize="${tokenizer(context)}");
      INSERT INTO memories_fts(memories_fts) VALUES('rebuild');
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content); END;
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content); END;
      CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `)]
  },
  {
    version: 4,
    name: 'features_1_9_foundations',
    operations: script(`
      ALTER TABLE media ADD COLUMN deleted_at TEXT;
      ALTER TABLE media ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE media ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
      CREATE INDEX idx_media_deleted ON media(deleted_at, created_at DESC);
      CREATE INDEX idx_media_favorite ON media(favorite, deleted_at, created_at DESC);
      CREATE TABLE push_subscriptions (
        endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, expiration_time INTEGER,
        visible INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT, fail_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_push_updated ON push_subscriptions(updated_at DESC);
      CREATE TABLE world_entries (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('entity','relation','fact','scene','timeline')),
        subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL, value_json TEXT NOT NULL DEFAULT '{}',
        confidence REAL NOT NULL DEFAULT 0.6, authority TEXT NOT NULL DEFAULT 'model' CHECK (authority IN ('model','user','admin')),
        source_message_id TEXT, active INTEGER NOT NULL DEFAULT 1, conflict_of TEXT REFERENCES world_entries(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_world_active ON world_entries(active, kind, updated_at DESC);
      CREATE INDEX idx_world_identity ON world_entries(subject, predicate, active);
      CREATE INDEX idx_world_source ON world_entries(source_message_id);
      CREATE TABLE world_sources (
        entry_id TEXT NOT NULL REFERENCES world_entries(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (entry_id, message_id)
      );
      CREATE TABLE audit_log (id TEXT PRIMARY KEY, category TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
      CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
      CREATE TABLE storage_samples (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, media_bytes INTEGER NOT NULL, data_bytes INTEGER NOT NULL, free_bytes INTEGER);
      CREATE INDEX idx_storage_samples_created ON storage_samples(created_at DESC);
    `)
  },
  {
    version: 5,
    name: 'world_identity_keys',
    operations: script(`
      ALTER TABLE world_entries ADD COLUMN subject_key TEXT NOT NULL DEFAULT '';
      ALTER TABLE world_entries ADD COLUMN predicate_key TEXT NOT NULL DEFAULT '';
      UPDATE world_entries SET subject_key = lower(trim(subject)), predicate_key = lower(trim(predicate));
      UPDATE world_entries AS loser
      SET active = 0,
          conflict_of = (
            SELECT winner.id FROM world_entries AS winner
            WHERE winner.active = 1 AND winner.conflict_of IS NULL
              AND winner.subject_key = loser.subject_key AND winner.predicate_key = loser.predicate_key
            ORDER BY CASE winner.authority WHEN 'admin' THEN 3 WHEN 'user' THEN 2 ELSE 1 END DESC,
                     winner.confidence DESC, winner.updated_at DESC, winner.id ASC LIMIT 1
          )
      WHERE loser.active = 1 AND loser.conflict_of IS NULL
        AND loser.id <> (
          SELECT winner.id FROM world_entries AS winner
          WHERE winner.active = 1 AND winner.conflict_of IS NULL
            AND winner.subject_key = loser.subject_key AND winner.predicate_key = loser.predicate_key
          ORDER BY CASE winner.authority WHEN 'admin' THEN 3 WHEN 'user' THEN 2 ELSE 1 END DESC,
                   winner.confidence DESC, winner.updated_at DESC, winner.id ASC LIMIT 1
        );
      CREATE INDEX idx_world_identity_keys ON world_entries(subject_key, predicate_key, active);
      CREATE UNIQUE INDEX idx_world_one_active_identity ON world_entries(subject_key, predicate_key) WHERE active = 1 AND conflict_of IS NULL;
    `)
  },
  {
    version: 6,
    name: 'life_engine',
    operations: script(`
      CREATE TABLE life_state (
        id INTEGER PRIMARY KEY CHECK (id = 1), activity TEXT NOT NULL, kind TEXT NOT NULL, mood TEXT NOT NULL,
        started_at TEXT NOT NULL, ends_at TEXT NOT NULL, updated_at TEXT NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE life_log (
        id TEXT PRIMARY KEY, activity TEXT NOT NULL, kind TEXT NOT NULL, mood TEXT NOT NULL,
        started_at TEXT NOT NULL, ended_at TEXT NOT NULL, shared INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE INDEX idx_life_log_started ON life_log(started_at DESC);
      CREATE INDEX idx_life_log_shared ON life_log(shared, started_at DESC);
    `)
  },
  { version: 7, name: 'remove_world_engine', operations: script(`DELETE FROM jobs WHERE type IN ('world.extract','world.rebuild'); DELETE FROM events WHERE type = 'world.updated'; DROP TABLE IF EXISTS world_sources; DROP TABLE IF EXISTS world_entries;`) },
  {
    version: 8,
    name: 'durable_reply_batches',
    operations: script(`
      CREATE TABLE reply_batches (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL DEFAULT 'main',
        status TEXT NOT NULL CHECK (status IN ('collecting','queued','running','completed','failed','cancelled')),
        trigger_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        assistant_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        opened_at TEXT NOT NULL, due_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, last_error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_expires_at TEXT, meta_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_reply_batches_status_due ON reply_batches(status, due_at);
      CREATE TABLE reply_batch_messages (
        batch_id TEXT NOT NULL REFERENCES reply_batches(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (batch_id, message_id), UNIQUE (message_id), UNIQUE (batch_id, position)
      );
      CREATE INDEX idx_reply_batch_messages_order ON reply_batch_messages(batch_id, position);
      CREATE UNIQUE INDEX idx_messages_one_active_reply_per_batch ON messages(json_extract(meta_json, '$.batchId'))
        WHERE role = 'assistant' AND status IN ('sending','sent') AND json_extract(meta_json, '$.batchId') IS NOT NULL;
    `)
  },
  { version: 9, name: 'media_text_extraction', operations: script(`CREATE TABLE media_text (media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK (status IN ('pending','ready','failed','unsupported')), text TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', error TEXT, updated_at TEXT NOT NULL);`) },
  {
    version: 10,
    name: 'message_history_search',
    operations: (context) => [executeOperation(messageFtsSql(tokenizer(context)))]
  },
  {
    version: 11,
    name: 'life_engine_2_plans_events',
    operations: script(`
      CREATE TABLE life_plans (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, planned_start TEXT, planned_end TEXT,
        status TEXT NOT NULL CHECK (status IN ('planned','active','paused','completed','cancelled','skipped')),
        source TEXT NOT NULL CHECK (source IN ('routine','generated','admin','conversation')),
        priority INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_life_plans_status_time ON life_plans(status, planned_start, priority DESC);
      CREATE TABLE life_events (
        id TEXT PRIMARY KEY, plan_id TEXT REFERENCES life_plans(id) ON DELETE SET NULL,
        log_id TEXT UNIQUE REFERENCES life_log(id) ON DELETE CASCADE, event_type TEXT NOT NULL,
        activity TEXT NOT NULL, kind TEXT NOT NULL, description TEXT NOT NULL, mood_before TEXT, mood_after TEXT,
        happened_at TEXT NOT NULL, shareable INTEGER NOT NULL DEFAULT 0, shared_at TEXT,
        meta_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      );
      CREATE INDEX idx_life_events_happened ON life_events(happened_at DESC);
      CREATE INDEX idx_life_events_shareable ON life_events(shareable, shared_at, happened_at DESC);
    `)
  },
  {
    version: 12,
    name: 'memory_lifecycle_supersession',
    operations: script(`
      ALTER TABLE memories ADD COLUMN supersedes_id TEXT REFERENCES memories(id) ON DELETE SET NULL;
      ALTER TABLE memories ADD COLUMN superseded_by_id TEXT REFERENCES memories(id) ON DELETE SET NULL;
      ALTER TABLE memories ADD COLUMN archived_at TEXT;
      CREATE INDEX idx_memories_supersedes ON memories(supersedes_id);
      CREATE INDEX idx_memories_superseded_by ON memories(superseded_by_id);
      CREATE INDEX idx_memories_archived ON memories(kind, archived_at, active);
      UPDATE memories SET active = 0, updated_at = datetime('now') WHERE kind = 'summary' AND active = 1;
    `)
  },
  {
    version: 13,
    name: 'proactive_reach_out_attempts',
    operations: script(`
      CREATE TABLE proactive_attempts (
        id TEXT PRIMARY KEY, candidate_id TEXT, candidate_kind TEXT, candidate_activity TEXT,
        status TEXT NOT NULL CHECK (status IN ('blocked','sent','failed')), blocked_reason TEXT,
        requested_mode TEXT CHECK (requested_mode IN ('text','text_sticker','voice','image')),
        final_mode TEXT CHECK (final_mode IN ('text','text_sticker','voice','image')), fallback_reason TEXT,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL, send_success INTEGER NOT NULL DEFAULT 0,
        user_response_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL, user_responded_at TEXT,
        detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_proactive_attempts_created ON proactive_attempts(created_at DESC);
      CREATE INDEX idx_proactive_attempts_response ON proactive_attempts(user_response_message_id, created_at DESC);
      CREATE INDEX idx_proactive_attempts_candidate ON proactive_attempts(candidate_id, created_at DESC);
    `)
  },
  {
    version: 14,
    name: 'messages_batch_id_column',
    operations: script(`
      ALTER TABLE messages ADD COLUMN batch_id TEXT;
      DROP INDEX idx_messages_one_active_reply_per_batch;
      UPDATE messages SET batch_id = json_extract(meta_json, '$.batchId') WHERE role = 'assistant' AND json_extract(meta_json, '$.batchId') IS NOT NULL;
      CREATE INDEX idx_messages_batch ON messages(batch_id);
      CREATE UNIQUE INDEX idx_messages_one_active_reply_per_batch ON messages(batch_id)
        WHERE role = 'assistant' AND status IN ('sending','sent') AND batch_id IS NOT NULL;
    `)
  },
  {
    version: 15,
    name: 'interruptible_reply_batches',
    operations: script(`
      CREATE TABLE reply_batches_new (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL DEFAULT 'main',
        status TEXT NOT NULL CHECK (status IN ('collecting','queued','generating','publishing','running','completed','superseded','failed','cancelled')),
        trigger_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        assistant_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        opened_at TEXT NOT NULL, due_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, last_error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_expires_at TEXT, meta_json TEXT NOT NULL DEFAULT '{}',
        revision INTEGER NOT NULL DEFAULT 1, last_message_at TEXT, generation_started_at TEXT, publish_started_at TEXT,
        visible_at TEXT, retry_count INTEGER NOT NULL DEFAULT 0, interrupted_count INTEGER NOT NULL DEFAULT 0,
        superseded_at TEXT, failure_code TEXT
      );
      INSERT INTO reply_batches_new (
        id, conversation_id, status, trigger_message_id, assistant_message_id, opened_at, due_at, started_at,
        completed_at, last_error, attempts, lease_owner, lease_expires_at, meta_json
      ) SELECT id, conversation_id, CASE status WHEN 'running' THEN 'generating' ELSE status END,
        trigger_message_id, assistant_message_id, opened_at, due_at, started_at, completed_at, last_error,
        attempts, lease_owner, lease_expires_at, meta_json FROM reply_batches;
      CREATE TABLE reply_batch_messages_new (
        batch_id TEXT NOT NULL REFERENCES reply_batches_new(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (batch_id, message_id), UNIQUE (message_id), UNIQUE (batch_id, position)
      );
      INSERT INTO reply_batch_messages_new SELECT batch_id, message_id, position, created_at FROM reply_batch_messages;
      DROP TABLE reply_batch_messages;
      DROP TABLE reply_batches;
      ALTER TABLE reply_batches_new RENAME TO reply_batches;
      ALTER TABLE reply_batch_messages_new RENAME TO reply_batch_messages;
      CREATE INDEX idx_reply_batches_status_due ON reply_batches(status, due_at);
      CREATE INDEX idx_reply_batch_messages_order ON reply_batch_messages(batch_id, position);
      CREATE TABLE reply_generations (
        id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES reply_batches(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL,
        finished_at TEXT, interruption_reason TEXT, error_code TEXT, duration_ms INTEGER, first_token_ms INTEGER, visible_ms INTEGER
      );
      CREATE INDEX idx_reply_generations_batch ON reply_generations(batch_id, revision);
    `)
  },
  {
    version: 16,
    name: 'voice_generations',
    operations: script(`
      CREATE TABLE voice_generations (
        id TEXT PRIMARY KEY, batch_id TEXT, revision INTEGER NOT NULL DEFAULT 0,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL, text_part_id TEXT, mode TEXT NOT NULL,
        requested_by TEXT NOT NULL, status TEXT NOT NULL, spoken_text TEXT NOT NULL, synthesis_text TEXT NOT NULL,
        delivery_json TEXT NOT NULL DEFAULT '{}', naturalness_json TEXT NOT NULL DEFAULT '{}', provider TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0, started_at TEXT, completed_at TEXT, failed_at TEXT,
        failure_code TEXT, media_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_voice_generations_batch_revision ON voice_generations(batch_id, revision);
      CREATE INDEX idx_voice_generations_message ON voice_generations(message_id);
    `)
  },
  {
    version: 17,
    name: 'life_system_v2',
    operations: script(`
      CREATE TABLE life_vitals (
        id INTEGER PRIMARY KEY CHECK (id = 1), energy REAL NOT NULL, hunger REAL NOT NULL, stress REAL NOT NULL,
        social_need REAL NOT NULL, loneliness REAL NOT NULL, curiosity REAL NOT NULL, comfort REAL NOT NULL,
        focus REAL NOT NULL, sleep_debt REAL NOT NULL, updated_at TEXT NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE life_day_themes (
        id TEXT PRIMARY KEY, local_date TEXT NOT NULL UNIQUE, theme TEXT NOT NULL,
        tone_tags_json TEXT NOT NULL DEFAULT '[]', source_factors_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
      );
      CREATE TABLE life_threads (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0, importance REAL NOT NULL DEFAULT 0, heat REAL NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_advanced_at TEXT,
        next_actions_json TEXT NOT NULL DEFAULT '[]', meta_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE life_activity_usage (
        activity_id TEXT PRIMARY KEY, last_used_at TEXT, use_count_7d INTEGER NOT NULL DEFAULT 0,
        use_count_30d INTEGER NOT NULL DEFAULT 0, consecutive_days INTEGER NOT NULL DEFAULT 0,
        semantic_tags_json TEXT NOT NULL DEFAULT '[]', recent_outcomes_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
      );
      CREATE TABLE life_share_candidates (
        id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_id TEXT NOT NULL, novelty REAL NOT NULL DEFAULT 0,
        relevance_to_user REAL NOT NULL DEFAULT 0, emotional_value REAL NOT NULL DEFAULT 0, urgency REAL NOT NULL DEFAULT 0,
        repetition_penalty REAL NOT NULL DEFAULT 0, status TEXT NOT NULL, created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL, shared_at TEXT, meta_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_life_share_candidates_status ON life_share_candidates(status, created_at);
      ALTER TABLE life_plans ADD COLUMN day_theme_id TEXT;
      ALTER TABLE life_plans ADD COLUMN flexible_start_minutes INTEGER NOT NULL DEFAULT 60;
      ALTER TABLE life_plans ADD COLUMN estimated_duration_minutes INTEGER;
      ALTER TABLE life_plans ADD COLUMN optional INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE life_plans ADD COLUMN thread_id TEXT;
      ALTER TABLE life_plans ADD COLUMN related_message_id TEXT;
      ALTER TABLE life_plans ADD COLUMN started_at TEXT;
      ALTER TABLE life_plans ADD COLUMN completed_at TEXT;
      ALTER TABLE life_plans ADD COLUMN outcome_id TEXT;
      ALTER TABLE life_events ADD COLUMN magnitude TEXT NOT NULL DEFAULT 'tiny';
      ALTER TABLE life_events ADD COLUMN result_type TEXT;
      ALTER TABLE life_events ADD COLUMN novelty_score REAL NOT NULL DEFAULT 0;
      ALTER TABLE life_events ADD COLUMN relevance_score REAL NOT NULL DEFAULT 0;
      ALTER TABLE life_events ADD COLUMN narrative_fingerprint TEXT;
    `)
  },
  { version: 18, name: 'proactive_candidate_sent_once', operations: script(`CREATE UNIQUE INDEX idx_proactive_candidate_sent_once ON proactive_attempts(candidate_id) WHERE status = 'sent' AND candidate_id IS NOT NULL;`) },
  {
    version: 19,
    name: 'life_locations',
    operations: script(`
      CREATE TABLE life_locations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('home','neighborhood','cafe','restaurant','store','park','library','mall','transit','work','study','venue','outdoor','other')),
        city TEXT, region TEXT, country TEXT, time_zone TEXT, lat REAL, lng REAL, tags_json TEXT NOT NULL DEFAULT '[]',
        indoor INTEGER NOT NULL DEFAULT 0, visit_weight REAL NOT NULL DEFAULT 1.0,
        source TEXT NOT NULL DEFAULT 'builtin' CHECK (source IN ('builtin','generated','admin','conversation')),
        active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_life_locations_active ON life_locations(active, kind);
      CREATE TABLE life_location_edges (
        from_id TEXT NOT NULL REFERENCES life_locations(id) ON DELETE CASCADE,
        to_id TEXT NOT NULL REFERENCES life_locations(id) ON DELETE CASCADE,
        travel_minutes INTEGER NOT NULL DEFAULT 15,
        mode TEXT NOT NULL DEFAULT 'walk' CHECK (mode IN ('walk','bike','transit','car','unknown')),
        PRIMARY KEY (from_id, to_id)
      );
      CREATE TABLE life_location_state (
        id INTEGER PRIMARY KEY CHECK (id = 1), location_id TEXT NOT NULL REFERENCES life_locations(id) ON DELETE CASCADE,
        arrived_at TEXT NOT NULL, expected_leave_at TEXT, source_plan_id TEXT, source_activity_id TEXT,
        confidence REAL NOT NULL DEFAULT 1.0, updated_at TEXT NOT NULL
      );
      CREATE TABLE life_location_visits (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES life_locations(id) ON DELETE CASCADE,
        entered_at TEXT NOT NULL, left_at TEXT, source_plan_id TEXT, source_activity_id TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX idx_life_location_visits ON life_location_visits(location_id, entered_at DESC);
    `)
  },
  {
    version: 20,
    name: 'weather_snapshots',
    operations: script(`
      CREATE TABLE weather_snapshots (
        location_key TEXT NOT NULL, observed_at TEXT NOT NULL,
        condition TEXT NOT NULL DEFAULT 'unknown' CHECK (condition IN ('clear','cloudy','rain','snow','storm','fog','wind','unknown')),
        temperature_c REAL, feels_like_c REAL, humidity REAL, precipitation_mm REAL, wind_kph REAL,
        provider TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (location_key, observed_at)
      );
      CREATE INDEX idx_weather_snapshots_key ON weather_snapshots(location_key, observed_at DESC);
    `)
  },
  { version: 21, name: 'metric_daily', operations: script(`CREATE TABLE metric_daily (date TEXT NOT NULL, category TEXT NOT NULL, metric TEXT NOT NULL, sum_value REAL NOT NULL DEFAULT 0, count INTEGER NOT NULL DEFAULT 0, last_updated TEXT NOT NULL, PRIMARY KEY (date, category, metric));`) },
  { version: 22, name: 'shadow_runs', operations: script(`CREATE TABLE shadow_runs (id TEXT PRIMARY KEY, subsystem TEXT NOT NULL, canonical_version TEXT NOT NULL, shadow_version TEXT NOT NULL, input_fingerprint TEXT NOT NULL, canonical_decision TEXT NOT NULL, shadow_decision TEXT NOT NULL, diff_json TEXT NOT NULL DEFAULT '{}', duration_ms INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL); CREATE INDEX idx_shadow_runs_subsystem ON shadow_runs(subsystem, created_at DESC);`) },
  {
    version: 23,
    name: 'experiments',
    operations: script(`
      CREATE TABLE experiments (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, subsystem TEXT NOT NULL, variants_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','shadow','running','paused','completed','cancelled')),
        assignment_scope TEXT NOT NULL DEFAULT 'day' CHECK (assignment_scope IN ('day','session','conversation')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE experiment_assignments (
        experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        scope_key TEXT NOT NULL, variant TEXT NOT NULL, assigned_at TEXT NOT NULL, PRIMARY KEY (experiment_id, scope_key)
      );
      CREATE TABLE experiment_events (
        id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        variant TEXT NOT NULL, event TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX idx_experiment_events ON experiment_events(experiment_id, created_at DESC);
    `)
  },
  {
    version: 24,
    name: 'visible_thoughts',
    operations: script(`
      CREATE TABLE visible_thoughts (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL, batch_id TEXT NOT NULL, revision INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('inner_monologue','decision_summary')), text TEXT NOT NULL DEFAULT '',
        visibility TEXT NOT NULL CHECK (visibility IN ('user','admin')),
        status TEXT NOT NULL CHECK (status IN ('generating','completed','cancelled','failed')), created_at TEXT NOT NULL
      );
      CREATE INDEX idx_thoughts_message ON visible_thoughts(message_id);
      CREATE INDEX idx_thoughts_batch_rev ON visible_thoughts(batch_id, revision);
      CREATE INDEX idx_thoughts_visibility ON visible_thoughts(visibility);
      CREATE INDEX idx_thoughts_created ON visible_thoughts(created_at);
      CREATE TABLE decision_traces (batch_id TEXT NOT NULL, revision INTEGER NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (batch_id, revision));
      CREATE INDEX idx_decision_traces_created ON decision_traces(created_at DESC);
    `)
  },
  {
    version: 25,
    name: 'life_cities_travel',
    operations: script(`
      CREATE TABLE life_cities (
        id TEXT PRIMARY KEY, key TEXT UNIQUE, name TEXT NOT NULL, region TEXT, country TEXT,
        time_zone TEXT NOT NULL DEFAULT 'Asia/Shanghai', active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_life_cities_active ON life_cities(active);
      CREATE TABLE travel_state (
        id INTEGER PRIMARY KEY CHECK (id = 1), from_location_id TEXT NOT NULL REFERENCES life_locations(id) ON DELETE CASCADE,
        to_location_id TEXT NOT NULL REFERENCES life_locations(id) ON DELETE CASCADE,
        mode TEXT NOT NULL DEFAULT 'walk' CHECK (mode IN ('walk','bike','transit','car','unknown')),
        started_at TEXT NOT NULL, expected_arrive_at TEXT NOT NULL, source_plan_id TEXT, source_activity_id TEXT, created_at TEXT NOT NULL
      );
      ALTER TABLE life_locations ADD COLUMN city_id TEXT REFERENCES life_cities(id) ON DELETE SET NULL;
      ALTER TABLE life_locations ADD COLUMN key TEXT;
      CREATE UNIQUE INDEX idx_life_locations_key ON life_locations(key) WHERE key IS NOT NULL;
    `)
  },
  {
    version: 26,
    name: 'metrics_distributions',
    operations: script(`
      ALTER TABLE metric_daily ADD COLUMN min_value REAL;
      ALTER TABLE metric_daily ADD COLUMN max_value REAL;
      CREATE TABLE metric_distributions (
        date TEXT NOT NULL, category TEXT NOT NULL, metric TEXT NOT NULL, bucket REAL NOT NULL,
        count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (date, category, metric, bucket)
      );
    `)
  },
  { version: 27, name: 'experiment_rollout', operations: script(`ALTER TABLE experiments ADD COLUMN rollout_percent INTEGER NOT NULL DEFAULT 100 CHECK (rollout_percent IN (10,25,50,100));`) },
  {
    version: 28,
    name: 'weather_forecasts',
    operations: script(`
      ALTER TABLE weather_snapshots ADD COLUMN visibility_km REAL;
      ALTER TABLE weather_snapshots ADD COLUMN pressure_hpa REAL;
      CREATE TABLE weather_forecasts (
        location_key TEXT NOT NULL, generated_at TEXT NOT NULL, provider TEXT NOT NULL,
        periods_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (location_key, generated_at)
      );
      CREATE INDEX idx_weather_forecasts_key ON weather_forecasts(location_key, generated_at DESC);
      CREATE TABLE weather_daylight (
        location_key TEXT NOT NULL, local_date TEXT NOT NULL, sunrise TEXT NOT NULL, sunset TEXT NOT NULL,
        provider TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (location_key, local_date)
      );
    `)
  },
  { version: 29, name: 'cleanup_experiments_shadow_geocoding_decision_trace', operations: script(`DROP TABLE IF EXISTS experiment_assignments; DROP TABLE IF EXISTS experiment_events; DROP TABLE IF EXISTS experiments; DROP TABLE IF EXISTS shadow_runs; DROP TABLE IF EXISTS decision_traces;`) },
  {
    version: 30,
    name: 'sticker_semantics_v2',
    operations: (context) => [executeOperation(`
      ALTER TABLE stickers ADD COLUMN description TEXT NOT NULL DEFAULT '';
      ALTER TABLE stickers ADD COLUMN image_text TEXT NOT NULL DEFAULT '';
      ALTER TABLE stickers ADD COLUMN name_source TEXT NOT NULL DEFAULT 'legacy' CHECK (name_source IN ('legacy','builtin','manual','auto'));
      ALTER TABLE stickers ADD COLUMN user_meaning TEXT NOT NULL DEFAULT '';
      ALTER TABLE stickers ADD COLUMN user_meaning_source TEXT NOT NULL DEFAULT 'none' CHECK (user_meaning_source IN ('none','ai','manual'));
      ALTER TABLE stickers ADD COLUMN user_meaning_confidence REAL;
      ALTER TABLE stickers ADD COLUMN user_meaning_updated_at TEXT;
      ALTER TABLE stickers ADD COLUMN analysis_status TEXT NOT NULL DEFAULT 'pending' CHECK (analysis_status IN ('pending','processing','ready','failed'));
      ALTER TABLE stickers ADD COLUMN analysis_source TEXT NOT NULL DEFAULT 'legacy' CHECK (analysis_source IN ('legacy','ai','manual'));
      ALTER TABLE stickers ADD COLUMN analysis_version INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE stickers ADD COLUMN analysis_model TEXT;
      ALTER TABLE stickers ADD COLUMN analyzed_at TEXT;
      ALTER TABLE stickers ADD COLUMN analysis_error TEXT;
      ALTER TABLE stickers ADD COLUMN embedding BLOB;
      ALTER TABLE stickers ADD COLUMN embedding_dim INTEGER;
      ALTER TABLE stickers ADD COLUMN embedding_model TEXT;
      ALTER TABLE stickers ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE stickers ADD COLUMN user_use_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE stickers ADD COLUMN user_last_used_at TEXT;
      ALTER TABLE stickers ADD COLUMN updated_at TEXT;
      UPDATE stickers SET updated_at = created_at WHERE updated_at IS NULL;
      CREATE INDEX idx_stickers_analysis ON stickers(analysis_status, analysis_version);
      CREATE INDEX idx_stickers_favorite ON stickers(favorite, enabled);
      CREATE INDEX idx_stickers_user_recent ON stickers(user_last_used_at DESC);
      CREATE VIRTUAL TABLE sticker_semantics_fts USING fts5(sticker_id UNINDEXED, content, tokenize='${tokenizer(context)}');
      INSERT INTO sticker_semantics_fts(sticker_id, content)
      SELECT id, '名称：' || name || char(10) || '标准含义：' || name || char(10) ||
        '图片文字：' || char(10) || '标签：' || replace(tags_json, '"', ' ') || char(10) || '旧情绪：' || emotion FROM stickers;
    `)]
  },
  {
    version: 31,
    name: 'prioritize_durable_jobs',
    operations: script(`
      ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 50;
      UPDATE jobs SET priority = CASE type
        WHEN 'reply' THEN 100 WHEN 'push.reply' THEN 95 WHEN 'media.extract_text' THEN 90
        WHEN 'life.conversation' THEN 75 WHEN 'life.tick' THEN 75 WHEN 'weather.refresh' THEN 70
        WHEN 'sticker.analyze' THEN 20 WHEN 'sticker.analyze.backfill' THEN 20 WHEN 'sticker.embed' THEN 15
        WHEN 'sticker.user-meaning.learn' THEN 75 WHEN 'sticker.embed.backfill' THEN 10
        WHEN 'memory.embed.backfill' THEN 10 WHEN 'maintenance' THEN 10 WHEN 'backup.create' THEN 5 ELSE 50 END;
      CREATE INDEX idx_jobs_claim ON jobs(status, priority DESC, created_at ASC);
    `)
  },
  { version: 32, name: 'media_animation_metadata', operations: script(`ALTER TABLE media ADD COLUMN animated INTEGER NOT NULL DEFAULT 0;`) },
  { version: 33, name: 'sticker_semantic_revision', operations: script(`ALTER TABLE stickers ADD COLUMN semantic_revision INTEGER NOT NULL DEFAULT 0;`) },
  {
    version: 34,
    name: 'moments_feed',
    operations: script(`
      CREATE TABLE moments (
        id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL UNIQUE, text TEXT NOT NULL,
        image_media_id TEXT REFERENCES media(id) ON DELETE SET NULL, image_kind TEXT CHECK (image_kind IN ('pov','selfie')),
        activity TEXT NOT NULL, location_id TEXT, location_name TEXT, city TEXT, weather_condition TEXT,
        temperature_c REAL, liked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE INDEX idx_moments_created ON moments(created_at DESC);
      ALTER TABLE proactive_attempts ADD COLUMN moment_id TEXT REFERENCES moments(id) ON DELETE SET NULL;
    `)
  },
  {
    version: 35,
    name: 'ombre_commit_receipts',
    operations: script(`
      CREATE TABLE ombre_commits (
        batch_id TEXT NOT NULL, revision INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('running','completed','uncertain','failed','skipped')),
        started_at TEXT, completed_at TEXT, detail_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (batch_id, revision)
      );
      CREATE INDEX idx_ombre_commits_state ON ombre_commits(state, started_at);
    `)
  },
  {
    version: 36,
    name: 'local_runtime',
    operations: (context) => [executeOperation(`
      CREATE TABLE app_runtime (
        id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL,
        trigram_fts INTEGER NOT NULL DEFAULT 0, installed_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        meta_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE migration_receipts (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, source_version INTEGER, detail_json TEXT NOT NULL DEFAULT '{}', applied_at TEXT NOT NULL
      );
      INSERT INTO app_runtime(id, schema_version, trigram_fts, installed_at, updated_at)
      VALUES (1, 36, ${context.trigramFts ? 1 : 0}, datetime('now'), datetime('now'));
    `)]
  },
  {
    version: 37,
    name: 'native_mcp',
    operations: script(`
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        url TEXT NOT NULL, transport TEXT NOT NULL, auth_type TEXT NOT NULL, secret_ref TEXT,
        required INTEGER NOT NULL DEFAULT 0, connect_timeout_ms INTEGER NOT NULL,
        tool_timeout_ms INTEGER NOT NULL, protocol_mode TEXT NOT NULL DEFAULT 'auto',
        state TEXT NOT NULL DEFAULT 'closed', last_error TEXT, last_connected_at TEXT, last_refresh_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE mcp_tool_policies (
        server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
        remote_name TEXT NOT NULL, canonical_name TEXT NOT NULL, risk TEXT NOT NULL,
        phases_json TEXT NOT NULL, authorized INTEGER NOT NULL DEFAULT 0, schema_hash TEXT,
        updated_at TEXT NOT NULL, PRIMARY KEY(server_id, remote_name)
      );
      CREATE INDEX idx_mcp_servers_enabled ON mcp_servers(enabled, state);
      CREATE INDEX idx_mcp_tool_authorized ON mcp_tool_policies(server_id, authorized);
    `)
  },
  {
    version: 38,
    name: 'secret_refs',
    operations: script(`
      CREATE TABLE secret_refs (
        ref TEXT PRIMARY KEY, kind TEXT NOT NULL, configured INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_secret_refs_configured ON secret_refs(configured, kind);
    `)
  },
  {
    version: 39,
    name: 'life_clock',
    operations: script(`
      CREATE TABLE life_clock_state (
        id INTEGER PRIMARY KEY CHECK (id = 1), last_settled_at TEXT NOT NULL,
        simulation_version INTEGER NOT NULL DEFAULT 1, seed_version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}'
      );
    `)
  },
  {
    version: 40,
    name: 'moment_runtime_cleanup',
    operations: script(`
      DELETE FROM jobs WHERE type IN ('push.reply','proactive.send','proactive.tick');
      UPDATE mcp_tool_policies SET phases_json = replace(phases_json, '"proactive"', '"moment"') WHERE phases_json LIKE '%"proactive"%';
      ALTER TABLE moments ADD COLUMN topic_key TEXT;
      ALTER TABLE moments ADD COLUMN source_event_id TEXT;
      ALTER TABLE moments ADD COLUMN status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('pending','published','suppressed','failed'));
      ALTER TABLE moments ADD COLUMN shared_at TEXT;
      ALTER TABLE moments ADD COLUMN updated_at TEXT;
      UPDATE moments SET shared_at = created_at, updated_at = created_at WHERE updated_at IS NULL;
      CREATE INDEX idx_moments_topic_created ON moments(topic_key, created_at DESC);
      CREATE INDEX idx_moments_status_created ON moments(status, created_at DESC);
    `)
  },
  {
    version: 41,
    name: 'local_memory_provider',
    operations: script(`
      ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'local';
      ALTER TABLE memories ADD COLUMN source_id TEXT;
      ALTER TABLE memories ADD COLUMN source_hash TEXT;
      CREATE UNIQUE INDEX idx_memories_source_hash ON memories(source, source_hash) WHERE source_hash IS NOT NULL;
      CREATE TABLE local_memory_receipts (
        batch_id TEXT NOT NULL, revision INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('running','completed','uncertain','failed','skipped')),
        inserted INTEGER NOT NULL DEFAULT 0, merged INTEGER NOT NULL DEFAULT 0, reason TEXT,
        started_at TEXT NOT NULL, completed_at TEXT, detail_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY(batch_id, revision)
      );
      CREATE INDEX idx_local_memory_receipts_state ON local_memory_receipts(state, started_at);
    `)
  },
  {
    version: 42,
    name: 'local_update_state',
    operations: script(`
      CREATE TABLE local_update_state (
        id INTEGER PRIMARY KEY CHECK (id = 1), current_native_version TEXT, current_web_version TEXT,
        pending_web_version TEXT, pending_manifest_json TEXT, last_good_web_version TEXT,
        last_checked_at TEXT, last_applied_at TEXT, last_error TEXT, updated_at TEXT NOT NULL
      );
    `)
  },
  {
    version: 43,
    name: 'local_backup_metadata',
    operations: script(`
      CREATE TABLE local_backup_metadata (
        id TEXT PRIMARY KEY, target TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('creating','ready','failed','restored')),
        schema_version INTEGER NOT NULL, bytes INTEGER, sha256 TEXT, created_at TEXT NOT NULL,
        verified_at TEXT, restored_at TEXT, detail_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_local_backup_created ON local_backup_metadata(created_at DESC);
      UPDATE app_runtime SET schema_version = 43, updated_at = datetime('now') WHERE id = 1;
    `)
  }
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export interface MigrationResult {
  version: number;
  applied: number[];
  trigramFts: boolean;
}

export async function migrateDatabase(
  db: LocalDatabase,
  options: { now?: () => string } = {}
): Promise<MigrationResult> {
  await db.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const trigramFts = await probeTrigram(db);
  const rows = await db.query<{ version: number }>('SELECT version FROM schema_migrations');
  const appliedVersions = new Set(rows.map((row) => row.version));
  const applied: number[] = [];
  const context = { trigramFts };
  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue;
    const timestamp = options.now?.() ?? nowIso();
    await runTransaction(db, [
      ...migration.operations(context),
      runOperation(
        'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
        [migration.version, migration.name, timestamp]
      )
    ]);
    applied.push(migration.version);
  }
  return { version: LATEST_SCHEMA_VERSION, applied, trigramFts };
}

async function probeTrigram(db: LocalDatabase): Promise<boolean> {
  try {
    await db.execute(`
      CREATE VIRTUAL TABLE temp.__sooya_fts_probe USING fts5(content, tokenize='trigram');
      DROP TABLE temp.__sooya_fts_probe;
    `);
    return true;
  } catch {
    try { await db.execute('DROP TABLE IF EXISTS temp.__sooya_fts_probe'); } catch { /* ignore probe cleanup */ }
    return false;
  }
}

function messageFtsSql(ftsTokenizer: string): string {
  const rebuild = (messageExpression: string) => `
    DELETE FROM messages_fts WHERE message_id = ${messageExpression};
    INSERT INTO messages_fts(message_id, conversation_id, content)
    SELECT m.id, m.conversation_id,
      COALESCE((SELECT group_concat(
        CASE WHEN p.type IN ('text','audio') THEN COALESCE(p.text, p.transcript, '')
             ELSE COALESCE(media.rel_path, '') || ' ' || COALESCE(media_text.text, '') END, ' ')
        FROM message_parts p
        LEFT JOIN media ON media.id = p.media_id
        LEFT JOIN media_text ON media_text.media_id = p.media_id
        WHERE p.message_id = m.id), '')
    FROM messages m WHERE m.id = ${messageExpression};`;
  return `
    CREATE VIRTUAL TABLE messages_fts USING fts5(message_id UNINDEXED, conversation_id UNINDEXED, content, tokenize='${ftsTokenizer}');
    INSERT INTO messages_fts(message_id, conversation_id, content)
    SELECT m.id, m.conversation_id,
      COALESCE((SELECT group_concat(
        CASE WHEN p.type IN ('text','audio') THEN COALESCE(p.text, p.transcript, '')
             ELSE COALESCE(media.rel_path, '') || ' ' || COALESCE(media_text.text, '') END, ' ')
        FROM message_parts p
        LEFT JOIN media ON media.id = p.media_id
        LEFT JOIN media_text ON media_text.media_id = p.media_id
        WHERE p.message_id = m.id), '') FROM messages m;
    CREATE TRIGGER message_parts_fts_ai AFTER INSERT ON message_parts BEGIN ${rebuild('new.message_id')} END;
    CREATE TRIGGER message_parts_fts_au AFTER UPDATE OF text, transcript, media_id, type ON message_parts BEGIN ${rebuild('new.message_id')} END;
    CREATE TRIGGER message_parts_fts_ad AFTER DELETE ON message_parts BEGIN ${rebuild('old.message_id')} END;
    CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN DELETE FROM messages_fts WHERE message_id = old.id; END;
    CREATE TRIGGER media_text_fts_ai AFTER INSERT ON media_text BEGIN
      DELETE FROM messages_fts WHERE message_id IN (SELECT message_id FROM message_parts WHERE media_id = new.media_id);
      INSERT INTO messages_fts(message_id, conversation_id, content)
      SELECT m.id, m.conversation_id, COALESCE((SELECT group_concat(
        CASE WHEN p.type IN ('text','audio') THEN COALESCE(p.text, p.transcript, '')
             ELSE COALESCE(media.rel_path, '') || ' ' || COALESCE(media_text.text, '') END, ' ')
        FROM message_parts p LEFT JOIN media ON media.id = p.media_id
        LEFT JOIN media_text ON media_text.media_id = p.media_id WHERE p.message_id = m.id), '')
      FROM messages m WHERE m.id IN (SELECT message_id FROM message_parts WHERE media_id = new.media_id);
    END;
    CREATE TRIGGER media_text_fts_au AFTER UPDATE OF text, status ON media_text BEGIN
      DELETE FROM messages_fts WHERE message_id IN (SELECT message_id FROM message_parts WHERE media_id = new.media_id);
      INSERT INTO messages_fts(message_id, conversation_id, content)
      SELECT m.id, m.conversation_id, COALESCE((SELECT group_concat(
        CASE WHEN p.type IN ('text','audio') THEN COALESCE(p.text, p.transcript, '')
             ELSE COALESCE(media.rel_path, '') || ' ' || COALESCE(media_text.text, '') END, ' ')
        FROM message_parts p LEFT JOIN media ON media.id = p.media_id
        LEFT JOIN media_text ON media_text.media_id = p.media_id WHERE p.message_id = m.id), '')
      FROM messages m WHERE m.id IN (SELECT message_id FROM message_parts WHERE media_id = new.media_id);
    END;
    CREATE TRIGGER media_text_fts_ad AFTER DELETE ON media_text BEGIN
      DELETE FROM messages_fts WHERE message_id IN (SELECT message_id FROM message_parts WHERE media_id = old.media_id);
      INSERT INTO messages_fts(message_id, conversation_id, content)
      SELECT m.id, m.conversation_id, COALESCE((SELECT group_concat(
        CASE WHEN p.type IN ('text','audio') THEN COALESCE(p.text, p.transcript, '')
             ELSE COALESCE(media.rel_path, '') || ' ' || COALESCE(media_text.text, '') END, ' ')
        FROM message_parts p LEFT JOIN media ON media.id = p.media_id
        LEFT JOIN media_text ON media_text.media_id = p.media_id WHERE p.message_id = m.id), '')
      FROM messages m WHERE m.id IN (SELECT message_id FROM message_parts WHERE media_id = old.media_id);
    END;
  `;
}
