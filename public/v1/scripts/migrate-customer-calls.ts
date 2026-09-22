import { migrateLegacyCalls } from '../comms/calls/migration.js';
const args=process.argv.slice(2),org=args[args.indexOf('--org')+1];
if(!args.includes('--org')||!org||org.startsWith('--'))throw new Error('Use --org ORGANIZATION_ID, optionally --apply. The default is a dry run.');
const report=await migrateLegacyCalls(org,args.includes('--apply'));
process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
process.exit(report.conflicts.length?2:0);
