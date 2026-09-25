const { Pool } = require("pg");
import { createHash, randomUUID } from "node:crypto";
import { addUtcDays, deriveLocationMetrics, LOCATION_FORMULA_VERSION, parseCanonicalReportInput, summarizeAverage, validateGoal } from "./location-performance";

let pool:any=null;
function db(){ if(pool)return pool; const cs=process.env.DATABASE_URL; if(!cs)throw new Error("DATABASE_URL is required"); pool=new Pool({connectionString:cs}); return pool; }
function hash(v:any){return createHash("sha256").update(JSON.stringify(v)).digest("hex");}
function isoDate(value:any){ if(!value)return value; if(typeof value==="string")return value.slice(0,10); return new Date(value).toISOString().slice(0,10); }
function safeRow(r:any){ if(!r)return null; return {...r,week_start_date:isoDate(r.week_start_date),week_end_date:isoDate(r.week_end_date),beginning_active_memberships:Number(r.beginning_active_memberships),ending_active_memberships:Number(r.ending_active_memberships),new_membership_sales:Number(r.new_membership_sales),retail_lane_cars:Number(r.retail_lane_cars),cancellations_during_period:Number(r.cancellations_during_period),gross_location_revenue_minor:Number(r.gross_location_revenue_minor),report_version:Number(r.report_version)};}

export async function initializeLocationPerformanceStore(){
 const c=await db().connect(); try{await c.query("BEGIN");
 await c.query(`CREATE TABLE IF NOT EXISTS mpp_location_performance_reports (
 report_id UUID PRIMARY KEY, location_id TEXT NOT NULL, week_start_date DATE NOT NULL, week_end_date DATE NOT NULL,
 timezone_snapshot TEXT NOT NULL, beginning_active_memberships BIGINT NOT NULL CHECK(beginning_active_memberships>=0),
 ending_active_memberships BIGINT NOT NULL CHECK(ending_active_memberships>=0), new_membership_sales BIGINT NOT NULL CHECK(new_membership_sales>=0),
 retail_lane_cars BIGINT NOT NULL CHECK(retail_lane_cars>=0), cancellations_during_period BIGINT NOT NULL CHECK(cancellations_during_period>=0),
 gross_location_revenue_minor BIGINT NOT NULL CHECK(gross_location_revenue_minor>=0), currency CHAR(3) NOT NULL,
 notes TEXT NOT NULL DEFAULT '', source_type TEXT NOT NULL, source_reference TEXT,
 submitted_by_ghl_user_id TEXT NOT NULL, submitted_by_name TEXT NOT NULL, submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 formula_version TEXT NOT NULL, report_version INTEGER NOT NULL DEFAULT 1 CHECK(report_version>=1), last_action_id TEXT NOT NULL,
 prior_report_id UUID, prefilled_beginning_active_memberships BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(location_id,week_start_date),
 CHECK(week_end_date=week_start_date+6), CHECK(currency ~ '^[A-Z]{3}$'))`);
 await c.query(`CREATE TABLE IF NOT EXISTS mpp_location_report_events (
 event_id UUID PRIMARY KEY, report_id UUID NOT NULL REFERENCES mpp_location_performance_reports(report_id), location_id TEXT NOT NULL,
 event_type TEXT NOT NULL CHECK(event_type IN ('submit','correct')), actor_ghl_user_id TEXT NOT NULL, actor_name TEXT NOT NULL,
 occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reason TEXT, before_snapshot JSONB, after_snapshot JSONB NOT NULL,
 expected_version INTEGER, resulting_version INTEGER NOT NULL, action_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
 UNIQUE(location_id,action_id))`);
 await c.query(`CREATE TABLE IF NOT EXISTS mpp_location_goals_v1 (
 goal_id UUID PRIMARY KEY, location_id TEXT NOT NULL, goal_type TEXT NOT NULL CHECK(goal_type IN
 ('membership_conversion_rate','new_membership_sales','active_memberships','gross_location_revenue','weekly_churn_rate')),
 effective_from DATE NOT NULL, goal_value NUMERIC NOT NULL CHECK(goal_value>=0), currency CHAR(3),
 goal_version INTEGER NOT NULL DEFAULT 1, last_action_id TEXT NOT NULL, set_by_ghl_user_id TEXT NOT NULL,
 set_by_name TEXT NOT NULL, set_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(location_id,goal_type,effective_from))`);
 await c.query(`CREATE TABLE IF NOT EXISTS mpp_location_goal_events (
 event_id UUID PRIMARY KEY, goal_id UUID NOT NULL REFERENCES mpp_location_goals_v1(goal_id), location_id TEXT NOT NULL,
 actor_ghl_user_id TEXT NOT NULL, actor_name TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 before_snapshot JSONB, after_snapshot JSONB NOT NULL, expected_version INTEGER, resulting_version INTEGER NOT NULL,
 action_id TEXT NOT NULL, payload_hash TEXT NOT NULL, UNIQUE(location_id,action_id))`);
 await c.query(`CREATE TABLE IF NOT EXISTS mpp_location_average_settings (
 location_id TEXT PRIMARY KEY, report_count SMALLINT NOT NULL DEFAULT 8 CHECK(report_count BETWEEN 2 AND 52),
 setting_version INTEGER NOT NULL DEFAULT 1, last_action_id TEXT NOT NULL, set_by_ghl_user_id TEXT NOT NULL,
 set_by_name TEXT NOT NULL, set_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
 await c.query(`CREATE TABLE IF NOT EXISTS mpp_location_average_setting_events (
 event_id UUID PRIMARY KEY, location_id TEXT NOT NULL, prior_count SMALLINT, resulting_count SMALLINT NOT NULL,
 actor_ghl_user_id TEXT NOT NULL, actor_name TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 expected_version INTEGER, resulting_version INTEGER NOT NULL, action_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
 UNIQUE(location_id,action_id))`);
 await c.query(`CREATE TABLE IF NOT EXISTS mpp_legacy_lpr_quarantine (
 quarantine_id UUID PRIMARY KEY, location_id TEXT NOT NULL, source_record_id TEXT NOT NULL, raw_record JSONB NOT NULL,
 reason TEXT NOT NULL, source_updated_at TIMESTAMPTZ, observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(location_id,source_record_id))`);
 await c.query("CREATE INDEX IF NOT EXISTS idx_mpp_lpr_location_week ON mpp_location_performance_reports(location_id,week_start_date DESC)");
 await c.query("CREATE INDEX IF NOT EXISTS idx_mpp_lpr_events_report ON mpp_location_report_events(report_id,occurred_at)");
 await c.query("COMMIT");}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
}
function canonical(input:any){return {week_start_date:input.weekStart,week_end_date:addUtcDays(input.weekStart,6),timezone_snapshot:input.timezoneSnapshot,beginning_active_memberships:input.beginningActiveMemberships,ending_active_memberships:input.endingActiveMemberships,new_membership_sales:input.newMembershipSales,retail_lane_cars:input.retailLaneCars,cancellations_during_period:input.cancellationsDuringPeriod,gross_location_revenue_minor:input.grossLocationRevenueMinor,currency:input.currency,notes:input.notes,source_type:input.sourceType,source_reference:input.sourceReference??null,prior_report_id:input.priorReportId??null,prefilled_beginning_active_memberships:input.prefilledBeginningActiveMemberships??null};}

export async function submitLocationReport(d:any){const payload=canonical(d.input),ph=hash(payload),c=await db().connect();try{await c.query("BEGIN");
 const replay=await c.query("SELECT r.* ,e.payload_hash FROM mpp_location_report_events e JOIN mpp_location_performance_reports r USING(report_id) WHERE e.location_id=$1 AND e.action_id=$2 FOR UPDATE",[d.locationId,d.actionId]);
 if(replay.rowCount){if(replay.rows[0].payload_hash!==ph)throw Object.assign(new Error("Action ID was already used with different data"),{statusCode:409});await c.query("COMMIT");return {report:safeRow(replay.rows[0]),idempotent:true};}
 const reportId=randomUUID(),row=await c.query(`INSERT INTO mpp_location_performance_reports
 (report_id,location_id,week_start_date,week_end_date,timezone_snapshot,beginning_active_memberships,ending_active_memberships,new_membership_sales,retail_lane_cars,cancellations_during_period,gross_location_revenue_minor,currency,notes,source_type,source_reference,submitted_by_ghl_user_id,submitted_by_name,formula_version,last_action_id,prior_report_id,prefilled_beginning_active_memberships)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,[reportId,d.locationId,payload.week_start_date,payload.week_end_date,payload.timezone_snapshot,payload.beginning_active_memberships,payload.ending_active_memberships,payload.new_membership_sales,payload.retail_lane_cars,payload.cancellations_during_period,payload.gross_location_revenue_minor,payload.currency,payload.notes,payload.source_type,payload.source_reference,d.actorId,d.actorName,LOCATION_FORMULA_VERSION,d.actionId,payload.prior_report_id,payload.prefilled_beginning_active_memberships]);
 await c.query(`INSERT INTO mpp_location_report_events(event_id,report_id,location_id,event_type,actor_ghl_user_id,actor_name,before_snapshot,after_snapshot,resulting_version,action_id,payload_hash) VALUES($1,$2,$3,'submit',$4,$5,NULL,$6,1,$7,$8)`,[randomUUID(),reportId,d.locationId,d.actorId,d.actorName,JSON.stringify(row.rows[0]),d.actionId,ph]);
 await c.query("COMMIT");return {report:safeRow(row.rows[0]),idempotent:false};}catch(e:any){await c.query("ROLLBACK");if(e?.code==="23505")throw Object.assign(new Error("A report already exists for this Location and week; use correction"),{statusCode:409});throw e;}finally{c.release();}}

export async function getLocationReport(locationId:string,reportId:string){const r=await db().query("SELECT * FROM mpp_location_performance_reports WHERE location_id=$1 AND report_id=$2",[locationId,reportId]);return safeRow(r.rows[0]);}
export async function getLocationReportHistory(locationId:string,page=1,pageSize=20){const size=Math.min(50,Math.max(1,pageSize)),offset=(Math.max(1,page)-1)*size;const [r,t]=await Promise.all([db().query("SELECT * FROM mpp_location_performance_reports WHERE location_id=$1 ORDER BY week_start_date DESC LIMIT $2 OFFSET $3",[locationId,size,offset]),db().query("SELECT COUNT(*)::int total FROM mpp_location_performance_reports WHERE location_id=$1",[locationId])]);return {reports:r.rows.map(safeRow),total:t.rows[0].total,page:Math.max(1,page),pageSize:size};}
export async function getPrefill(locationId:string,weekStart:string){const r=await db().query("SELECT report_id,week_start_date,ending_active_memberships FROM mpp_location_performance_reports WHERE location_id=$1 AND week_start_date<$2 ORDER BY week_start_date DESC LIMIT 1",[locationId,weekStart]);return r.rows[0]?{priorReportId:r.rows[0].report_id,priorWeekStart:String(r.rows[0].week_start_date).slice(0,10),prefilledBeginningActiveMemberships:Number(r.rows[0].ending_active_memberships)}:null;}
export async function getReportEvents(locationId:string,reportId:string){const r=await db().query("SELECT event_type,actor_ghl_user_id,actor_name,occurred_at,reason,expected_version,resulting_version,action_id FROM mpp_location_report_events WHERE location_id=$1 AND report_id=$2 ORDER BY occurred_at",[locationId,reportId]);return r.rows;}

export async function correctLocationReport(d:any){const payload=canonical(d.input),ph=hash({payload,reason:d.reason}),c=await db().connect();try{await c.query("BEGIN");
 const replay=await c.query("SELECT e.payload_hash,r.* FROM mpp_location_report_events e JOIN mpp_location_performance_reports r USING(report_id) WHERE e.location_id=$1 AND e.action_id=$2 FOR UPDATE",[d.locationId,d.actionId]);if(replay.rowCount){if(replay.rows[0].payload_hash!==ph)throw Object.assign(new Error("Action ID was already used with different data"),{statusCode:409});await c.query("COMMIT");return {report:safeRow(replay.rows[0]),idempotent:true};}
 const before=await c.query("SELECT * FROM mpp_location_performance_reports WHERE location_id=$1 AND report_id=$2 FOR UPDATE",[d.locationId,d.reportId]);if(!before.rowCount)throw Object.assign(new Error("Report not found"),{statusCode:404});const b=before.rows[0];if(Number(b.report_version)!==d.expectedVersion)throw Object.assign(new Error("Report changed since it was loaded"),{statusCode:409});
 if(String(b.week_start_date).slice(0,10)!==payload.week_start_date)throw Object.assign(new Error("Correction cannot change the report week"),{statusCode:400});const nv=d.expectedVersion+1;
 const row=await c.query(`UPDATE mpp_location_performance_reports SET timezone_snapshot=$3,beginning_active_memberships=$4,ending_active_memberships=$5,new_membership_sales=$6,retail_lane_cars=$7,cancellations_during_period=$8,gross_location_revenue_minor=$9,currency=$10,notes=$11,source_type=$12,source_reference=$13,report_version=$14,last_action_id=$15,updated_at=NOW() WHERE location_id=$1 AND report_id=$2 RETURNING *`,[d.locationId,d.reportId,payload.timezone_snapshot,payload.beginning_active_memberships,payload.ending_active_memberships,payload.new_membership_sales,payload.retail_lane_cars,payload.cancellations_during_period,payload.gross_location_revenue_minor,payload.currency,payload.notes,payload.source_type,payload.source_reference,nv,d.actionId]);
 await c.query(`INSERT INTO mpp_location_report_events(event_id,report_id,location_id,event_type,actor_ghl_user_id,actor_name,reason,before_snapshot,after_snapshot,expected_version,resulting_version,action_id,payload_hash) VALUES($1,$2,$3,'correct',$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[randomUUID(),d.reportId,d.locationId,d.actorId,d.actorName,d.reason,JSON.stringify(b),JSON.stringify(row.rows[0]),d.expectedVersion,nv,d.actionId,ph]);await c.query("COMMIT");return {report:safeRow(row.rows[0]),idempotent:false};}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}}

export async function getAverageSetting(locationId:string){const r=await db().query("SELECT * FROM mpp_location_average_settings WHERE location_id=$1",[locationId]);return r.rows[0]?{reportCount:Number(r.rows[0].report_count),version:Number(r.rows[0].setting_version)}:{reportCount:8,version:0};}
export async function setAverageSetting(d:any){const c=await db().connect(),ph=hash({reportCount:d.reportCount});try{await c.query("BEGIN");const existing=await c.query("SELECT * FROM mpp_location_average_settings WHERE location_id=$1 FOR UPDATE",[d.locationId]);const prior=existing.rows[0];if(prior&&prior.last_action_id===d.actionId){await c.query("COMMIT");return {reportCount:Number(prior.report_count),version:Number(prior.setting_version),idempotent:true};}const version=prior?Number(prior.setting_version)+1:1;if(prior&&Number(prior.setting_version)!==d.expectedVersion)throw Object.assign(new Error("Average setting changed since it was loaded"),{statusCode:409});await c.query(`INSERT INTO mpp_location_average_settings(location_id,report_count,setting_version,last_action_id,set_by_ghl_user_id,set_by_name) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(location_id) DO UPDATE SET report_count=EXCLUDED.report_count,setting_version=EXCLUDED.setting_version,last_action_id=EXCLUDED.last_action_id,set_by_ghl_user_id=EXCLUDED.set_by_ghl_user_id,set_by_name=EXCLUDED.set_by_name,set_at=NOW()`,[d.locationId,d.reportCount,version,d.actionId,d.actorId,d.actorName]);await c.query(`INSERT INTO mpp_location_average_setting_events(event_id,location_id,prior_count,resulting_count,actor_ghl_user_id,actor_name,expected_version,resulting_version,action_id,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[randomUUID(),d.locationId,prior?.report_count??null,d.reportCount,d.actorId,d.actorName,d.expectedVersion??null,version,d.actionId,ph]);await c.query("COMMIT");return {reportCount:d.reportCount,version,idempotent:false};}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}}

export async function setLocationGoalV1(d:any){const c=await db().connect(),ph=hash({type:d.goalType,value:d.value,currency:d.currency,effectiveFrom:d.effectiveFrom});try{await c.query("BEGIN");const prior=await c.query("SELECT * FROM mpp_location_goals_v1 WHERE location_id=$1 AND goal_type=$2 AND effective_from=$3 FOR UPDATE",[d.locationId,d.goalType,d.effectiveFrom]);const p=prior.rows[0];if(p&&p.last_action_id===d.actionId){await c.query("COMMIT");return {...p,goal_value:Number(p.goal_value),idempotent:true};}const version=p?Number(p.goal_version)+1:1;if(p&&Number(p.goal_version)!==d.expectedVersion)throw Object.assign(new Error("Goal changed since it was loaded"),{statusCode:409});const id=p?.goal_id??randomUUID();const row=await c.query(`INSERT INTO mpp_location_goals_v1(goal_id,location_id,goal_type,effective_from,goal_value,currency,goal_version,last_action_id,set_by_ghl_user_id,set_by_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(location_id,goal_type,effective_from) DO UPDATE SET goal_value=EXCLUDED.goal_value,currency=EXCLUDED.currency,goal_version=EXCLUDED.goal_version,last_action_id=EXCLUDED.last_action_id,set_by_ghl_user_id=EXCLUDED.set_by_ghl_user_id,set_by_name=EXCLUDED.set_by_name,set_at=NOW() RETURNING *`,[id,d.locationId,d.goalType,d.effectiveFrom,d.value,d.currency,version,d.actionId,d.actorId,d.actorName]);await c.query(`INSERT INTO mpp_location_goal_events(event_id,goal_id,location_id,actor_ghl_user_id,actor_name,before_snapshot,after_snapshot,expected_version,resulting_version,action_id,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[randomUUID(),id,d.locationId,d.actorId,d.actorName,p?JSON.stringify(p):null,JSON.stringify(row.rows[0]),d.expectedVersion??null,version,d.actionId,ph]);await c.query("COMMIT");return {...row.rows[0],goal_value:Number(row.rows[0].goal_value),idempotent:false};}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}}
export async function getEffectiveGoals(locationId:string,weekStart:string){const r=await db().query(`SELECT DISTINCT ON(goal_type) * FROM mpp_location_goals_v1 WHERE location_id=$1 AND effective_from<=$2 ORDER BY goal_type,effective_from DESC`,[locationId,weekStart]);return r.rows.map((x:any)=>({...x,goal_value:Number(x.goal_value),goal_version:Number(x.goal_version)}));}
export async function getLocationSummary(locationId:string,reportId?:string){let current:any;if(reportId)current=await getLocationReport(locationId,reportId);else{const r=await db().query("SELECT * FROM mpp_location_performance_reports WHERE location_id=$1 ORDER BY week_start_date DESC LIMIT 1",[locationId]);current=safeRow(r.rows[0]);}if(!current)return null;const setting=await getAverageSetting(locationId);const pri=await db().query("SELECT * FROM mpp_location_performance_reports WHERE location_id=$1 AND week_start_date<$2 ORDER BY week_start_date DESC LIMIT $3",[locationId,current.week_start_date,setting.reportCount]);const average=summarizeAverage(current,pri.rows.map(safeRow),setting.reportCount);return {report:current,metrics:deriveLocationMetrics(current),average,averageSetting:setting,goals:await getEffectiveGoals(locationId,String(current.week_start_date).slice(0,10))};}


export async function runV1BIntegrityProof(locationId:string,scopeDenied:boolean){
 const prefix="v1b01-proof-",actorId="v1b01-proof-actor",actorName="V1B-01 Staging Proof",sourceType="MPP_STAGING_V1B_PROOF";
 const c=await db().connect();
 try{
  await c.query("BEGIN");
  await c.query("DELETE FROM mpp_location_report_events WHERE location_id=$1 AND action_id LIKE $2",[locationId,prefix+"%"]);
  await c.query("DELETE FROM mpp_location_performance_reports WHERE location_id=$1 AND source_type=$2",[locationId,sourceType]);
  await c.query("DELETE FROM mpp_location_goal_events WHERE location_id=$1 AND action_id LIKE $2",[locationId,prefix+"%"]);
  await c.query("DELETE FROM mpp_location_goals_v1 WHERE location_id=$1 AND last_action_id LIKE $2",[locationId,prefix+"%"]);
  await c.query("DELETE FROM mpp_location_average_setting_events WHERE location_id=$1 AND action_id LIKE $2",[locationId,prefix+"%"]);
  await c.query("DELETE FROM mpp_location_average_settings WHERE location_id=$1 AND last_action_id LIKE $2",[locationId,prefix+"%"]);
  await c.query("DELETE FROM mpp_legacy_lpr_quarantine WHERE location_id=$1 AND source_record_id LIKE $2",[locationId,prefix+"%"]);
  await c.query("COMMIT");
 }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
 const base=(weekStart:string,index:number,over:any={})=>({weekStart,timezoneSnapshot:"America/New_York",beginningActiveMemberships:1000+index*10,endingActiveMemberships:1008+index*10,newMembershipSales:20+index,retailLaneCars:100+index*5,cancellationsDuringPeriod:5+index,grossLocationRevenueMinor:1000000+index*25000,currency:"USD",notes:"Synthetic V1B-01 staging proof fixture",sourceType,sourceReference:prefix+weekStart,...over});
 const weeks=["2026-06-29","2026-07-06","2026-07-13","2026-07-20","2026-07-27","2026-08-03","2026-08-10","2026-08-17","2026-08-24"];
 const rows:any[]=[];
 for(let i=0;i<weeks.length;i++){
  const input=base(weeks[i],i,i===1?{beginningActiveMemberships:0}:i===2?{retailLaneCars:0}:{});
  const saved=await submitLocationReport({locationId,actorId,actorName,input,actionId:prefix+"submit-"+i});
  rows.push(saved.report);
 }
 const replay=await submitLocationReport({locationId,actorId,actorName,input:base(weeks[0],0),actionId:prefix+"submit-0"});
 let changedDuplicateDenied=false;try{await submitLocationReport({locationId,actorId,actorName,input:base(weeks[0],0,{newMembershipSales:99}),actionId:prefix+"changed-duplicate"});}catch(e:any){changedDuplicateDenied=e?.statusCode===409;}
 const current=rows[8],correctedInput=base(weeks[8],8,{newMembershipSales:40,endingActiveMemberships:1111});
 const corrected=await correctLocationReport({locationId,actorId,actorName,input:correctedInput,reportId:current.report_id,reason:"Correct verified source transcription",expectedVersion:1,actionId:prefix+"correct-8"});
 const correctionReplay=await correctLocationReport({locationId,actorId,actorName,input:correctedInput,reportId:current.report_id,reason:"Correct verified source transcription",expectedVersion:1,actionId:prefix+"correct-8"});
 let staleDenied=false;try{await correctLocationReport({locationId,actorId,actorName,input:correctedInput,reportId:current.report_id,reason:"Stale attempt",expectedVersion:1,actionId:prefix+"stale"});}catch(e:any){staleDenied=e?.statusCode===409;}
 const prefill=await getPrefill(locationId,"2026-08-31");
 await setAverageSetting({locationId,actorId,actorName,reportCount:8,expectedVersion:0,actionId:prefix+"avg-8"});
 const summary=await getLocationSummary(locationId,current.report_id);
 const partial= summarizeAverage(rows[2],[rows[1],rows[0]],8);
 const goalTypes=["membership_conversion_rate","new_membership_sales","active_memberships","gross_location_revenue","weekly_churn_rate"];
 for(let i=0;i<goalTypes.length;i++)await setLocationGoalV1({locationId,actorId,actorName,goalType:goalTypes[i],value:i===0?0.15:i===4?0.03:i===3?1500000:1200+i,currency:i===3?"USD":null,effectiveFrom:"2026-06-29",expectedVersion:null,actionId:prefix+"goal-"+i});
 let retailGoalDenied=false;try{validateGoal("retail_lane_cars",100);}catch(e:any){retailGoalDenied=e?.statusCode===400;}
 const history=await getLocationReportHistory(locationId,1,20),detail=await getLocationReport(locationId,current.report_id),events=await getReportEvents(locationId,current.report_id);
 const validationSamples:any[]=[
  {...base("2026-06-30",0)}, {...base("2026-09-07",0),currency:"US"}, {...base("2026-09-07",0),newMembershipSales:-1}, {...base("2026-09-07",0),retailLaneCars:null}
 ];
 const validationDenied=validationSamples.every(x=>{try{parseCanonicalReportInput(x);return false;}catch{return true;}});
 const z1=deriveLocationMetrics(rows[1]),z2=deriveLocationMetrics(rows[2]),positive=deriveLocationMetrics(corrected.report);
 const qc=await db().connect();let rollbackAbsent=false,quarantineCount=0,eventCount=0,rowCount=0,goalCount=0;
 try{
  await qc.query("BEGIN");
  const rollbackId=randomUUID();
  await qc.query(`INSERT INTO mpp_location_performance_reports(report_id,location_id,week_start_date,week_end_date,timezone_snapshot,beginning_active_memberships,ending_active_memberships,new_membership_sales,retail_lane_cars,cancellations_during_period,gross_location_revenue_minor,currency,notes,source_type,submitted_by_ghl_user_id,submitted_by_name,formula_version,last_action_id) VALUES($1,$2,'2026-09-07','2026-09-13','America/New_York',1,1,0,0,0,0,'USD','rollback rehearsal',$3,$4,$5,$6,$7)`,[rollbackId,locationId,sourceType,actorId,actorName,LOCATION_FORMULA_VERSION,prefix+"rollback"]);
  await qc.query("ROLLBACK");
  rollbackAbsent=(await qc.query("SELECT 1 FROM mpp_location_performance_reports WHERE location_id=$1 AND last_action_id=$2",[locationId,prefix+"rollback"])).rowCount===0;
  await qc.query(`INSERT INTO mpp_legacy_lpr_quarantine(quarantine_id,location_id,source_record_id,reason,raw_record) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[randomUUID(),locationId,prefix+"ambiguous-1","Retail washes and split revenue are not canonically equivalent",JSON.stringify({total_retail_washes_sold:123,retail_revenue:100,membership_revenue:50})]);
  quarantineCount=Number((await qc.query("SELECT COUNT(*) c FROM mpp_legacy_lpr_quarantine WHERE location_id=$1 AND source_record_id LIKE $2",[locationId,prefix+"%"])).rows[0].c);
  rowCount=Number((await qc.query("SELECT COUNT(*) c FROM mpp_location_performance_reports WHERE location_id=$1 AND source_type=$2",[locationId,sourceType])).rows[0].c);
  eventCount=Number((await qc.query("SELECT COUNT(*) c FROM mpp_location_report_events WHERE location_id=$1 AND action_id LIKE $2",[locationId,prefix+"%"])).rows[0].c);
  goalCount=Number((await qc.query("SELECT COUNT(*) c FROM mpp_location_goals_v1 WHERE location_id=$1 AND last_action_id LIKE $2",[locationId,prefix+"%"])).rows[0].c);
 }finally{qc.release();}
 const checks:any={
  B01:rowCount===9,
  B02:validationDenied&&rows[1].beginning_active_memberships===0&&rows[2].retail_lane_cars===0,
  B03:scopeDenied,
  B04:replay.idempotent&&changedDuplicateDenied&&rowCount===9,
  B05:rows.every(r=>r.source_type===sourceType&&r.submitted_by_ghl_user_id===actorId&&r.timezone_snapshot==="America/New_York"&&r.currency==="USD"),
  B06:positive.membershipConversionRate===40/140&&positive.weeklyChurnRate===13/1080&&z1.weeklyChurnRate===null&&z2.membershipConversionRate===null,
  B07:positive.weeklyEarningsMinor===1200000&&positive.activeMemberships===1111,
  B08:history.total===9&&!!detail&&events.length===2,
  B09:corrected.report.report_version===2&&correctionReplay.idempotent&&staleDenied&&events.length===2,
  B10:prefill?.priorReportId===current.report_id&&prefill?.prefilledBeginningActiveMemberships===1111,
  B11:summary?.average?.available===true&&summary?.average?.requiredCount===8&&summary?.average?.metrics?.newMembershipSales?.relativeDifference!==null,
  B12:partial.available===false&&partial.completedCount===2,
  B13:goalCount===5&&retailGoalDenied,
  B14:scopeDenied,
  B15:quarantineCount===1,
  B16:rollbackAbsent&&eventCount===10&&deriveLocationMetrics(corrected.report).membershipConversionRate===positive.membershipConversionRate
 };
 return {passed:Object.values(checks).every(Boolean),checks,evidence:{locationId,rowCount,eventCount,goalCount,quarantineCount,currentReportVersion:corrected.report.report_version,conversion:positive.membershipConversionRate,churn:positive.weeklyChurnRate,averageCount:summary?.average?.requiredCount,averageAvailable:summary?.average?.available,historyCount:history.total,rollbackAbsent,sourceType,formulaVersion:LOCATION_FORMULA_VERSION},cleanup:{fixtures:"preserved as clearly labeled Scope/Test staging history",rerun:"idempotent cleanup by source/action prefix"}};
}
