import { env } from "../config/env.js";
import { closePostgresPools, queryPostgres, withPostgresTransaction } from "../database/postgres.js";

const CONFIRMATION = "SANITIZE_DEVELOPMENT_CLONE";

function hasConfirmation(argv: string[]) {
  const index = argv.indexOf("--confirm-development-sanitize");
  return index >= 0 && String(argv[index + 1] ?? "") === CONFIRMATION;
}

async function tableExists(name: string) {
  const result = await queryPostgres<{ exists: boolean }>("SELECT to_regclass($1) IS NOT NULL AS exists", [`public.${name}`]);
  return result.rows[0]?.exists === true;
}

async function main() {
  if (!env.dataEnvironmentExplicit || env.dataEnvironment !== "development") {
    throw new Error("Development sanitization requires FIRSTMEASURE_DATA_ENVIRONMENT=development explicitly.");
  }
  if (!hasConfirmation(process.argv.slice(2))) {
    throw new Error(`Development sanitization requires --confirm-development-sanitize ${CONFIRMATION}.`);
  }

  const existing = new Set<string>();
  for (const table of [
    "platform_sessions", "firstmeasure_jobs", "firstmeasure_queue_events", "projects",
    "app_shared_documents", "internal_documents", "internal_users_index"
  ]) {
    if (await tableExists(table)) existing.add(table);
  }

  const counts = await withPostgresTransaction(async (client) => {
    const changed: Record<string, number> = {};
    const run = async (name: string, sql: string, parameters: unknown[] = []) => {
      const result = await client.query(sql, parameters);
      changed[name] = result.rowCount ?? 0;
    };

    if (existing.has("platform_sessions")) {
      await run("sessions_deleted", "DELETE FROM platform_sessions");
    }
    if (existing.has("firstmeasure_jobs")) {
      await run("background_jobs_deleted", "DELETE FROM firstmeasure_jobs");
    }
    if (existing.has("firstmeasure_queue_events")) {
      await run("queue_events_deleted", "DELETE FROM firstmeasure_queue_events");
    }
    if (existing.has("projects")) {
      await run("project_ownership_reset", `
        UPDATE projects
        SET assigned_to_name = '', assigned_to_email = '',
            reserved_to_name = '', reserved_to_email = '',
            correction_to_name = '', correction_to_email = '',
            qa_claimed_by_name = '', qa_claimed_by_email = '',
            manifest_json = (((((((manifest_json
              #- '{workflow,assigned_to}')
              #- '{workflow,reserved_to}')
              #- '{workflow,qa_claimed_by}')
              - 'assigned_to_name') - 'assigned_to_email')
              - 'reserved_to_name') - 'reserved_to_email')
              - 'qa_claimed_by_name' - 'qa_claimed_by_email',
            updated_db_at = now()
        WHERE assigned_to_email <> '' OR reserved_to_email <> '' OR correction_to_email <> '' OR qa_claimed_by_email <> ''
      `);
    }
    if (existing.has("app_shared_documents")) {
      await run("communications_state_deleted", "DELETE FROM app_shared_documents WHERE namespace = 'communications'");
      await run("api_secret_state_deleted", `
        DELETE FROM app_shared_documents
        WHERE namespace = 'public_firstmeasure' AND collection IN ('key_secrets', 'key_deliveries')
      `);
    }
    if (existing.has("internal_documents")) {
      await run("provider_configuration_deleted", `
        DELETE FROM internal_documents
        WHERE (collection = 'server_config' AND id IN ('gmail_client_id','gmail_client_secret','gmail_redirect_uri'))
           OR (collection = 'config' AND id = 'apple_key')
           OR collection = 'apple_key_audit'
      `);
    }
    if (existing.has("internal_users_index")) {
      await run("gmail_user_tokens_removed", `
        UPDATE internal_users_index
        SET user_json = jsonb_set(
              user_json,
              '{integrations}',
              COALESCE(user_json->'integrations', '{}'::jsonb) - 'gmail',
              true
            ),
            updated_db_at = now()
        WHERE COALESCE(user_json->'integrations', '{}'::jsonb) ? 'gmail'
      `);
    }
    return changed;
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    environment: env.dataEnvironment,
    confirmation: CONFIRMATION,
    counts
  }, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePostgresPools().catch(() => undefined));
