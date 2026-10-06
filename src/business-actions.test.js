import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTool } from './tools.js';
import { executeExtended } from './operations.js';
import { executeBusiness, mergeGrant, validateSchedule, workflowDefaults, SHARE_RESOURCES } from './business-actions.js';
import { cardsForTool, changesData } from './cards.js';
import { buildSystemPrompt } from './prompt.js';

const auth = { accessToken:'main-fixture',apiKey:'active-fixture' };
function fixture(t, handler) {
  const previous = global.fetch, calls = [];
  global.fetch = async (address, init) => {
    const url = new URL(address);
    assert.equal(init.headers.Authorization,'Bearer main-fixture');
    assert.equal(init.headers['X-API-Key'],'active-fixture');
    const call = { path:url.pathname,query:url.searchParams,method:init.method,
      body:init.body instanceof FormData ? init.body : init.body ? JSON.parse(init.body) : null,headers:init.headers };
    calls.push(call);
    const data = await handler(call);
    return Response.json({state:true,...data});
  };
  t.after(()=>{global.fetch=previous;});
  return calls;
}
const run = async (name,args,context={}) => JSON.parse(await executeTool(name,JSON.stringify(args),auth,context));
const action = {step_id:{id:'email-1',type:'action'},step_type:'action',action_type:'email',model_id:7,parent_ids:[],is_initial:true,disable_auto_remove_responders:true,signature_id:9,unknown_preserved:{test:1}};
const workflow = {id:8,auto_remove_responders:true,steps:[action,{step_id:{id:'wait-2'},step_type:'event',event_type:'not_active',when_minutes:1440,parent_ids:[action.step_id]}]};
const grant = {name:'existing',sharing_type_to:'Team',read_permission:true,write_permission:true,delete_permission:false,ids_list:[],sharing_targets:[{id:91,name:'Sales'}]};
const schedule = { date_start:'2026-10-08 14:30:00',time_start_sending:'09:00:00',time_stop_sending:'18:00:00',time_sending_timezone:'Europe/Paris',
  contactlist_ids:[42],daily_send_limit:50,limit_total_sending:0,copy_prospect_if_scoring_above:0,priority_email:false,blacklist_ids:[],exclude_programmation_ids:[],
  ...Object.fromEntries(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map(day=>['allowed_'+day,!['saturday','sunday'].includes(day)])) };

test('workflow creation defaults exclusion globally and on actions without overwriting explicit choices', async t=>{
  const calls=fixture(t,()=>({workflow_id:8}));
  const body={name:'Sequence',steps:[{...action,disable_auto_remove_responders:undefined}]};
  assert.equal((await executeExtended('run_operation',{operation:'create_workflow',body},auth)).status,'accepted');
  assert.equal(calls[0].body.auto_remove_responders,true);
  assert.equal(calls[0].body.steps[0].disable_auto_remove_responders,false);
  assert.equal(workflowDefaults({...body,auto_remove_responders:false,steps:[action]}).payload.steps[0].disable_auto_remove_responders,true);
  assert.equal(workflowDefaults({...body,auto_remove_responders:false}).payload.auto_remove_responders,false);
});
test('reply branches cannot silently disable global exclusion and malformed steps never create a workflow',()=>{
  for(const event_type of ['email_answered','linkedin_message_answered','sms_replied']){
    assert.equal(workflowDefaults({steps:[action,{step_type:'event',event_type}]}).error,'reply_branch_conflicts_with_global_exclusion');
    assert.ok(workflowDefaults({steps:[action,{step_type:'event',event_type}],auto_remove_responders:false}).payload);
  }
  assert.ok(workflowDefaults({steps:[{...action,disable_auto_remove_responders:'false'}]}).error);
});
test('step exclusion uses the inverted field, preserves the full graph and does not change the global setting', async t=>{
  const calls=fixture(t,call=>call.method==='GET'?{workflow_profile:workflow}:{});
  assert.equal((await run('set_workflow_responder_exclusion',{workflow_id:8,step_id:'email-1',enabled:true})).status,'accepted');
  assert.deepEqual(calls[1].body,{steps:[{...action,disable_auto_remove_responders:false},workflow.steps[1]]});
  assert.equal((await run('set_workflow_responder_exclusion',{workflow_id:8,step_id:'wait-2',enabled:true})).error,'workflow_action_not_found');
  assert.equal((await run('set_workflow_responder_exclusion',{workflow_id:8,enabled:false})).scope,'sequence');
  assert.deepEqual(calls.at(-1).body,{auto_remove_responders:false});
  assert.equal(calls.filter(call=>call.method==='PUT').length,2);
});
test('manual contact creation resolves real identifiers to numeric IDs and refuses unknown fields before writing',async t=>{
  const calls=fixture(t,call=>call.path==='/data-fields'?{data_fields_list:[{id:5,identifier:'email'},{id:6,identifier:'first_name'}]}:call.method==='GET'?{contact_list_profile:{id:42}}:{contact_id:77});
  const context={};
  const args={list_id:42,values:{email:'a@example.test',first_name:'Alice'}};
  assert.equal((await run('add_contact_to_list',args,context)).status,'accepted');
  assert.deepEqual(calls.find(call=>call.method==='POST').body,{properties:[{data_field_id:5,value:'a@example.test'},{data_field_id:6,value:'Alice'}]});
  assert.equal((await run('add_contact_to_list',args,context)).error,'mutation_already_attempted');
  assert.equal((await run('add_contact_to_list',{list_id:42,values:{unknown:'x'}})).error,'invalid_contact_field');
  assert.equal(calls.filter(call=>call.method==='POST').length,1);
  assert.ok(!JSON.stringify(await run('add_contact_to_list',{list_id:42,values:{password:'secret'}})).includes('secret'));
});
test('saved contact filters preserve their complete nested conditions and page scope',async t=>{
  const filter={mode:'and',values:[{mode:'or',values:[{field_name:'5',type:'equals',value:['a','b']}]}]};
  fixture(t,()=>({user_profile:{id:1,saved_filters:{contact_lists_contacts:[{name:'Qualified',filter}],prm:[{name:'Other',filter}]}}}));
  assert.deepEqual((await run('list_saved_filters',{page:'contact_lists_contacts',name:'Qualified'})).filters,{contact_lists_contacts:[{name:'Qualified',filter}]});
});
test('initial launch time remains separate from recurring daily windows, including updates',async t=>{
  const calls=fixture(t,call=>call.method==='GET'?{workflow_programmation_profile:schedule}:{workflow_programmation_id:22});
  const result=await executeExtended('run_operation',{operation:'schedule_campaign',params:{workflow_id:8},body:schedule},auth);
  assert.equal(result.status,'accepted');
  assert.equal(calls[0].body.date_start,'2026-10-08 14:30:00');
  assert.equal(calls[0].body.time_start_sending,'09:00:00');
  assert.equal(validateSchedule({...schedule,date_start:'2026-02-30 14:30:00'},true),'invalid_schedule_date');
  assert.equal(validateSchedule({...schedule,date_start:'2026-10-08'},true),'schedule_initial_start_time_required');
  assert.equal(validateSchedule({...schedule,time_sending_timezone:'Invalid/Zone'},true),'invalid_schedule_timezone');
  assert.equal(validateSchedule({...schedule,time_start_sending_monday:'19:00:00'},true),'invalid_schedule_window');
  const update=await executeExtended('run_operation',{operation:'update_campaign_schedule',params:{workflow_id:8,id:22},body:{date_start:'2026-10-09 15:00:00'}},auth);
  assert.equal(update.status,'accepted');
  assert.deepEqual(calls.at(-1).body,{date_start:'2026-10-09 15:00:00'});
  const rejected=await executeExtended('run_operation',{operation:'update_campaign_schedule',params:{workflow_id:8,id:22},body:{time_stop_sending:'08:00:00'}},auth);
  assert.equal(rejected.error,'invalid_schedule_window');
});
test('sharing merge preserves named target IDs, ignores inherited grants and adds only read access',()=>{
  const shares=mergeGrant([grant,{...grant,implicit:true}],12);
  assert.deepEqual(shares[0].ids_list,[91]);
  assert.equal(shares[0].write_permission,true);
  assert.equal(shares[1].write_permission,false);
  assert.equal(shares[1].delete_permission,false);
  assert.deepEqual(mergeGrant([...shares],12),shares);
  assert.throws(()=>mergeGrant(null,12));
});
test('every supported row sharing type uses its own route and preserves existing grants, including multipart assets',async t=>{
  const calls=fixture(t,call=>{
    if(call.path==='/users/list/search')return {results:[{id:12,first_name:'Bob'}]};
    if(call.method==='GET')return {profile_fixture_profile:{id:8,account_type:'Gmail',sharing:[grant]}};
    return {};
  });
  for(const kind of Object.keys(SHARE_RESOURCES)){
    const result=await run('share_resource',{kind,resource_id:kind==='ai_agent'?'agent-abc':'8',user_id:12,reseller_id:99});
    assert.equal(result.status,'accepted',kind+': '+JSON.stringify(result));
    const written=calls.at(-1);
    if(['file','voice_model'].includes(kind)){
      assert.equal(written.method,'POST');
      assert.ok(written.body instanceof FormData);
      assert.equal(written.headers['Content-Type'],undefined);
      assert.equal(JSON.parse(written.body.get('sharing'))[0].ids_list[0],91);
    }else{
      assert.equal(written.method,kind==='mailgun_domain'?'POST':'PUT');
      assert.equal(written.body.sharing[0].ids_list[0],91);
      if(kind==='email_account')assert.equal(written.path,'/integrations/email/gmail/8');
    }
  }
});
test('campaign statistics and prospects are different grants; neither shares the whole PRM',async t=>{
  const calls=fixture(t,call=>call.path==='/users/list/search'?{results:[{id:12}]}:
    call.method==='GET'?{workflow_programmation_profile:{id:22,stats_sharings:[grant]}}:{});
  assert.equal((await run('share_resource',{kind:'campaign_statistics',workflow_id:8,resource_id:'22',user_id:12,write_permission:true})).status,'accepted');
  assert.equal(calls.at(-1).path,'/workflows/8/programmation/22');
  assert.ok(calls.at(-1).body.stats_sharings.every(item=>!item.write_permission&&!item.delete_permission));
  assert.equal((await run('share_resource',{kind:'campaign_prospects',resource_id:'22',user_id:12})).status,'accepted');
  assert.equal(calls.at(-1).path,'/prm/sharings');
  assert.deepEqual(calls.at(-1).body.sharing.filter,{mode:'and',values:[{field_name:'programmation_id',type:'equals',value:'22'}]});
  const before=calls.filter(call=>call.method==='POST'&&!call.path.includes('search')).length;
  assert.equal((await run('share_resource',{kind:'prm',user_id:12})).error,'explicit_prm_scope_required');
  assert.equal(calls.filter(call=>call.method==='POST'&&!call.path.includes('search')).length,before);
});
test('unverified recipients or missing ownership/grants never trigger a share write',async t=>{
  let recipients=[{id:12}],resource={id:8,from_sharing:true,sharing:[grant]};
  const calls=fixture(t,call=>call.path==='/users/list/search'?{results:recipients}:{model_profile:resource});
  assert.equal((await run('share_resource',{kind:'email_model',resource_id:'8',user_id:12})).error,'resource_not_owned_or_writable');
  resource={id:8,sharing:null};
  assert.equal((await run('share_resource',{kind:'email_model',resource_id:'8',user_id:12})).error,'sharing_unavailable');
  recipients=[];
  assert.equal((await run('share_resource',{kind:'email_model',resource_id:'8',user_id:12})).error,'sharing_user_not_verified');
  assert.ok(!calls.some(call=>call.method==='PUT'));
});
test('saved-filter sharing re-reads the profile and preserves own filters on other pages',async t=>{
  const own={name:'Qualified',filter:{mode:'and',values:[]},created_by:{id:1},sharing:[grant]};
  const other={name:'Other',filter:{mode:'and',values:[]},created_by:{id:1},sharing:[]};
  const calls=fixture(t,call=>call.path==='/users/list/search'?{results:[{id:12}]}:call.method==='GET'?{user_profile:{id:1,saved_filters:{contact_lists_contacts:[own],prm:[other,{...other,created_by:{id:99}}]}}}:{});
  assert.equal((await run('share_resource',{kind:'saved_filter',filter_page:'contact_lists_contacts',filter_name:'Qualified',user_id:12})).status,'accepted');
  assert.deepEqual(calls.at(-1).body.saved_filters.prm,[other]);
  assert.deepEqual(calls.at(-1).body.saved_filters.contact_lists_contacts[0].sharing[0].ids_list,[91]);
});
test('PRM blacklist copy preserves shared owner, page filter and selected IDs and requires a fresh matching count',async t=>{
  let count=3;
  const calls=fixture(t,call=>{
    if(call.path==='/prm/list')return {prm:[{id:391},{id:11,datafields:[{id:5,identifier:'email'}]}]};
    if(call.path==='/blacklists/7')return {blacklist_profile:{id:7}};
    if(call.path==='/prm/contacts/user/11')return {number_of_results:count,results:[]};
    if(call.path==='/prm/contacts/user/11/copy/blacklist/7')return {};
    throw Error('Unexpected route '+call.path);
  });
  const context={profile:{id:391},prmPage:{user_id:11,filter:{mode:'and',values:[{field_name:'score',type:'more_than',value:'20'}]},columns:[]}};
  const args={blacklist_id:7,contact_ids:[1,2,3],datafield_ids:[5]};
  assert.equal((await run('copy_prm_to_blacklist',args,context)).dry_run,true);
  count=2;
  assert.equal((await run('copy_prm_to_blacklist',{...args,confirm_count:3},context)).dry_run,true);
  assert.equal((await run('copy_prm_to_blacklist',{...args,confirm_count:2},context)).status,'accepted');
  const written=calls.find(call=>call.method==='POST');
  assert.equal(written.path,'/prm/contacts/user/11/copy/blacklist/7');
  assert.deepEqual(written.body.contacts_selection.contact_ids,[]);
  assert.deepEqual(written.body.contacts_selection.filter.values[0],{mode:'and',values:[context.prmPage.filter]});
  assert.deepEqual(written.body.contacts_selection.filter.values[1].values.map(condition=>condition.value),['1','2','3']);
  assert.equal((await run('copy_prm_to_blacklist',{...args,confirm_count:2},context)).error,'mutation_already_attempted');
  assert.equal(calls.filter(call=>call.method==='POST').length,1);
  assert.ok(!calls.some(call=>call.path==='/data-fields'));
});
test('reminders retain dates and do not mark responses as read',async t=>{
  const calls=fixture(t,()=>({contact_profile:{id:1,calls:[{id:2,name:'Follow up',call_date:'2099-10-09T10:00:00+02:00'},{id:3,call_date:'2099-10-09 11:00:00'},{id:4,call_date:'2000-01-01T10:00:00Z'}]}}));
  const result=await run('list_prm_reminders',{contact_id:1});
  assert.equal(result.reminders[0].call_date,'2099-10-09T10:00:00+02:00');
  assert.deepEqual(result.upcoming_reminders.map(call=>call.id),[2]);
  assert.equal(result.reminders.length,3);
  assert.equal(calls[0].method,'GET');
  assert.equal(calls[0].query.has('set_new_reply_read'),false);
});
test('secure UI cards carry IDs only; reconnect never creates another mailbox',async t=>{
  const calls=fixture(t,call=>call.path==='/integrations/email/8'?{email_account_profile:{id:8,refresh_token:'must-not-leak'}}:{contact_list_profile:{id:42}});
  const email=await run('connect_email',{account_id:8});
  assert.deepEqual(cardsForTool('connect_email',JSON.stringify(email)),[{kind:'email',account_id:8}]);
  assert.ok(!JSON.stringify(email).includes('must-not-leak'));
  const form=await run('open_commercial_form',{form:'import',list_id:42});
  assert.deepEqual(cardsForTool('open_commercial_form',JSON.stringify(form)),[{kind:'form',form:'import',list_id:42}]);
  assert.ok(calls.every(call=>call.method==='GET'));
  assert.equal(changesData('share_resource','{"status":"accepted"}'),true);
  assert.equal(changesData('copy_prm_to_blacklist','{"dry_run":true}'),false);
});
test('assistant guidance distinguishes exclusion levels, scheduling, imports, sharing and safe mail connection',()=>{
  const prompt=buildSystemPrompt({first_name:'Alice'});
  for(const token of ['auto_remove_responders:true','disable_auto_remove_responders:false','HEURE DU PREMIER LANCEMENT','PLAGE QUOTIDIENNE','list_saved_filters','share_resource','account_id','copy_prm_to_blacklist'])assert.ok(prompt.includes(token),token);
});

test('boolean and injected resource IDs, secret fields and unsupported sharing kinds cannot write',async t=>{
  const calls=fixture(t,()=>{throw Error('no request expected');});
  assert.equal((await run('add_contact_to_list',{list_id:true,values:{email:'a@example.test'}})).error,'invalid_list_id');
  assert.equal((await run('share_resource',{kind:'workflow',resource_id:'8',user_id:true})).error,'invalid_sharing_arguments');
  assert.equal((await run('list_prm_reminders',{contact_id:'../1'})).error,'invalid_contact_id');
  assert.equal((await run('list_saved_filters',{page:'arbitrary'})).error,'invalid_filter_page');
  assert.equal((await run('share_resource',{kind:'workflow',resource_id:'8',user_id:12,password:'secret'})).error,'invalid_arguments');
  assert.equal(calls.length,0);
});
