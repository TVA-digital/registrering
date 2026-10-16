'use strict';

const path = require('node:path');

function lagStorage(env = process.env) {
  const type = (env.STORAGE || 'sqlite').toLowerCase();
  if (type === 'firestore') {
    const { FirestoreStorage } = require('./firestore');
    return new FirestoreStorage({
      prosjekt: env.GOOGLE_CLOUD_PROJECT,
      database: env.FIRESTORE_DATABASE,
      prefiks: env.FIRESTORE_PREFIX || '',
    });
  }
  if (type === 'supabase') {
    const { SupabaseStorage } = require('./supabase');
    return new SupabaseStorage({ url: env.SUPABASE_URL, nokkel: env.SUPABASE_SERVICE_ROLE_KEY });
  }
  if (type === 'sqlite') {
    const { SqliteStorage } = require('./sqlite');
    return new SqliteStorage({ fil: env.SQLITE_FILE || path.join(__dirname, '..', '..', 'var', 'pameldinger.db') });
  }
  throw new Error(`Ukjent STORAGE="${type}". Bruk "sqlite", "supabase" eller "firestore".`);
}

module.exports = { lagStorage };
