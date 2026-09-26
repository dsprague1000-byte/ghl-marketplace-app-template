import test from "node:test";
import assert from "node:assert/strict";
import { assertPeopleMutationAllowed, canManagePeople, fixtureEmail, normalizeSerial, readinessResult } from "./people-policy";

test("fixture serials and plus aliases are deterministic",()=>{assert.equal(normalizeSerial("v1t_gm1_a"),"V1T_GM1_A");assert.equal(fixtureEmail("V1T_GM1_A"),"data_gaffneyconsult+V1T_GM1_A@symnavia.com");});
test("titles alone do not grant location scope",()=>{assert.throws(()=>assertPeopleMutationAllowed({actor:"owner",target:"seller",allowRmManageGms:false,actorHasLocation:false,targetLocationInActorScope:true}),/outside/);});
test("GM manages Seller and SM but not GM",()=>{assert.equal(canManagePeople("general_manager","seller",false),true);assert.equal(canManagePeople("general_manager","sales_manager",false),true);assert.equal(canManagePeople("general_manager","general_manager",false),false);});
test("RM managing GM is governance controlled",()=>{assert.equal(canManagePeople("regional_manager","general_manager",false),false);assert.equal(canManagePeople("regional_manager","general_manager",true),true);assert.equal(canManagePeople("regional_manager","owner",true),false);});
test("readiness fails partial setup with explicit reasons",()=>{const r=readinessResult({organizationActive:true,locations:[{active:true,installationEvidence:false,responsibleManager:true}],invalidRelationships:0,incompleteRequiredSteps:1});assert.equal(r.ready,false);assert.deepEqual(r.reasons,["installation_unverified","required_steps_incomplete"]);});
test("readiness succeeds only for complete topology",()=>{assert.deepEqual(readinessResult({organizationActive:true,locations:[{active:true,installationEvidence:true,responsibleManager:true}],invalidRelationships:0,incompleteRequiredSteps:0}),{ready:true,reasons:[]});});
