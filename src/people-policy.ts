export const RESPONSIBILITIES = ["seller", "sales_manager", "general_manager", "regional_manager", "owner"] as const;
export type Responsibility = typeof RESPONSIBILITIES[number];
export type LifecycleState = "invited" | "active" | "inactive";

export function policyError(message:string,statusCode=400,code="invalid_request") {
  return Object.assign(new Error(message),{statusCode,code});
}
export function requireActionId(value:unknown) {
  const actionId=String(value??"").trim();
  if(!actionId||actionId.length>160) throw policyError("Valid action ID required");
  return actionId;
}
export function normalizeResponsibility(value:unknown):Responsibility {
  const role=String(value??"").trim().toLowerCase().replace(/[\s-]+/g,"_") as Responsibility;
  if(!RESPONSIBILITIES.includes(role)) throw policyError("Primary Responsibility is not supported");
  return role;
}
export function normalizeSerial(value:unknown) {
  const serial=String(value??"").trim().toUpperCase();
  if(!/^V1T_[A-Z0-9_]{3,48}$/.test(serial)) throw policyError("Fixture serial is invalid");
  return serial;
}
export function fixtureEmail(serial:string) {
  return `data_gaffneyconsult+${normalizeSerial(serial)}@symnavia.com`;
}
export function canManagePeople(actor:Responsibility,target:Responsibility,allowRmManageGms:boolean) {
  if(actor==="owner") return true;
  if(actor==="regional_manager") return target!=="owner" && (target!=="general_manager"||allowRmManageGms);
  if(actor==="general_manager") return target==="seller"||target==="sales_manager";
  return false;
}
export function assertPeopleMutationAllowed(input:{actor:Responsibility;target:Responsibility;allowRmManageGms:boolean;actorHasLocation:boolean;targetLocationInActorScope:boolean}) {
  if(!input.actorHasLocation||!input.targetLocationInActorScope||!canManagePeople(input.actor,input.target,input.allowRmManageGms))
    throw policyError("People management is outside your authorized responsibility",403,"forbidden");
}
export function assertSameLocation(expected:string,actual:string) {
  if(!expected||expected!==actual) throw policyError("Relationship must remain within one Location",403,"cross_location");
}
export function readinessResult(input:{organizationActive:boolean;locations:Array<{active:boolean;installationEvidence:boolean;responsibleManager:boolean}>;invalidRelationships:number;incompleteRequiredSteps:number}) {
  const reasons:string[]=[];
  if(!input.organizationActive) reasons.push("organization_inactive");
  if(!input.locations.length) reasons.push("no_locations");
  if(input.locations.some(x=>!x.active)) reasons.push("location_inactive");
  if(input.locations.some(x=>!x.installationEvidence)) reasons.push("installation_unverified");
  if(input.locations.some(x=>!x.responsibleManager)) reasons.push("responsible_manager_missing");
  if(input.invalidRelationships) reasons.push("invalid_relationships");
  if(input.incompleteRequiredSteps) reasons.push("required_steps_incomplete");
  return {ready:reasons.length===0,reasons};
}
