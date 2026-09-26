export async function synchronizePersonProjections(client:any,personId:string,enabled:boolean){
  const identity=(await client.query("SELECT external_user_id FROM mpp_person_identity_links WHERE person_id=$1 AND provider='highlevel' AND link_state='active' LIMIT 1",[personId])).rows[0];
  if(!identity)return;
  const userId=identity.external_user_id;
  if(!enabled){
    await client.query("DELETE FROM mpp_assignment_index WHERE ghl_user_id=$1",[userId]);
    await client.query("DELETE FROM mpp_scope_grants WHERE ghl_user_id=$1",[userId]);
    await client.query("DELETE FROM mpp_sm_team_management WHERE sm_user_id=$1",[userId]);
    await client.query("UPDATE mpp_reporting_team_destinations SET active=FALSE,updated_at=NOW() WHERE ghl_user_id=$1",[userId]);
    const remaining=Number((await client.query(`SELECT (SELECT COUNT(*) FROM mpp_assignment_index WHERE ghl_user_id=$1)+(SELECT COUNT(*) FROM mpp_scope_grants WHERE ghl_user_id=$1)+(SELECT COUNT(*) FROM mpp_sm_team_management WHERE sm_user_id=$1)+(SELECT COUNT(*) FROM mpp_reporting_team_destinations WHERE ghl_user_id=$1 AND active=TRUE) count`,[userId])).rows[0].count);
    if(remaining!==0)throw new Error("People projection deactivation did not converge");
    return;
  }
  const accesses=(await client.query("SELECT a.location_id,l.assignment_record_id FROM mpp_person_location_access a JOIN mpp_person_assignment_links l USING(person_id,location_id) WHERE a.person_id=$1 AND a.state='active' AND l.state='active'",[personId])).rows;
  await client.query("DELETE FROM mpp_assignment_index WHERE ghl_user_id=$1",[userId]);
  await client.query("DELETE FROM mpp_scope_grants WHERE ghl_user_id=$1",[userId]);
  for(const a of accesses){
    await client.query(`INSERT INTO mpp_assignment_index(location_id,ghl_user_id,record_id,person_id,updated_at) VALUES($1,$2,$3,$4,NOW()) ON CONFLICT(location_id,ghl_user_id) DO UPDATE SET record_id=EXCLUDED.record_id,person_id=EXCLUDED.person_id,updated_at=NOW()`,[a.location_id,userId,a.assignment_record_id,personId]);
    await client.query(`INSERT INTO mpp_scope_grants(ghl_user_id,assignment_record_id,scope_type,scope_id,person_id) VALUES($1,$2,'location',$3,$4) ON CONFLICT(ghl_user_id,scope_type,scope_id) DO UPDATE SET assignment_record_id=EXCLUDED.assignment_record_id,person_id=EXCLUDED.person_id`,[userId,a.assignment_record_id,a.location_id,personId]);
  }
  const management=(await client.query("SELECT m.location_id,m.team_id,l.assignment_record_id FROM mpp_team_management_assignments m JOIN mpp_person_assignment_links l USING(person_id,location_id) WHERE m.person_id=$1 AND m.state='active' AND l.state='active'",[personId])).rows;
  await client.query("DELETE FROM mpp_sm_team_management WHERE sm_user_id=$1",[userId]);
  for(const m of management)await client.query(`INSERT INTO mpp_sm_team_management(location_id,sm_user_id,team_record_id,assignment_record_id,person_id,updated_at) VALUES($1,$2,$3,$4,$5,NOW()) ON CONFLICT(location_id,sm_user_id) DO UPDATE SET team_record_id=EXCLUDED.team_record_id,assignment_record_id=EXCLUDED.assignment_record_id,person_id=EXCLUDED.person_id,updated_at=NOW()`,[m.location_id,userId,m.team_id,m.assignment_record_id,personId]);
  await client.query("UPDATE mpp_reporting_team_destinations SET active=FALSE,updated_at=NOW() WHERE ghl_user_id=$1",[userId]);
  const reporting=(await client.query("SELECT r.location_id,r.team_id,t.display_name FROM mpp_reporting_team_eligibility r JOIN mpp_teams t ON t.team_id=r.team_id WHERE r.person_id=$1 AND r.state='active'",[personId])).rows;
  for(const r of reporting)await client.query(`INSERT INTO mpp_reporting_team_destinations(location_id,ghl_user_id,team_record_id,team_name,active,person_id,updated_at) VALUES($1,$2,$3,$4,TRUE,$5,NOW()) ON CONFLICT(location_id,ghl_user_id,team_record_id) DO UPDATE SET team_name=EXCLUDED.team_name,active=TRUE,person_id=EXCLUDED.person_id,updated_at=NOW()`,[r.location_id,userId,r.team_id,r.display_name,personId]);
  const projected=await client.query(`SELECT (SELECT COUNT(*) FROM mpp_assignment_index WHERE ghl_user_id=$1)::int assignments,(SELECT COUNT(*) FROM mpp_scope_grants WHERE ghl_user_id=$1)::int scopes,(SELECT COUNT(*) FROM mpp_sm_team_management WHERE sm_user_id=$1)::int management,(SELECT COUNT(*) FROM mpp_reporting_team_destinations WHERE ghl_user_id=$1 AND active=TRUE)::int reporting`,[userId]);
  const x=projected.rows[0];if(Number(x.assignments)!==accesses.length||Number(x.scopes)!==accesses.length||Number(x.management)!==management.length||Number(x.reporting)!==reporting.length)throw new Error("People canonical projections did not converge");
}
