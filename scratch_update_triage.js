const fs = require('fs');
const path = 'projects/worktrees/migration-chittycommand/src/routes/triage.ts';
let content = fs.readFileSync(path, 'utf8');

// replace 'system' with userId
content = content.replace(
  "const scopes = c.get('scopes') || [];",
  "const scopes = c.get('scopes') || [];\n  const userId = c.get('userId') || 'system';"
);

content = content.replace(
  "VALUES ('system', ${\'Triage: \' + intent_type}, 'Triage queue intent for review', ${finalPriority}, 'open', '{}'::jsonb)",
  "VALUES (${userId}, ${\'Triage: \' + intent_type}, 'Triage queue intent for review', ${finalPriority}, 'open', '{}'::jsonb)"
);

content = content.replace(
  "SELECT id, 'Plan for ' || title, 'draft', 'system', '{}'::jsonb",
  "SELECT id, 'Plan for ' || title, 'draft', ${userId}, '{}'::jsonb"
);

fs.writeFileSync(path, content);
