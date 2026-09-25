<template>
  <section class="lp-shell">
    <div class="lp-heading">
      <div><p class="eyebrow">Location management</p><h2>Location Performance</h2><p class="muted">{{ selectedScopeName }}</p></div>
      <button class="secondary-button" @click="refresh">Refresh</button>
    </div>

    <template v-if="isPortfolio">
      <article v-for="item in glance" :key="item.locationId" class="lp-card lp-location">
        <div><strong>{{ locationName(item.locationId) }}</strong><p class="muted">Individual Location performance</p></div>
        <template v-if="item.summary">
          <strong>{{ rate(item.summary.metrics.membershipConversionRate) }}</strong>
          <span>Conversion Rate</span><span>{{ rate(item.summary.metrics.weeklyChurnRate) }} churn</span>
          <button class="secondary-button" @click="$emit('select-location', item.locationId)">View Location</button>
        </template>
        <span v-else class="muted">No completed weekly report</span>
      </article>
    </template>

    <template v-else>
      <div class="lp-report-state"><span class="mini-pill">{{ summary ? 'Submitted' : 'Due' }}</span><span class="muted">{{ summary ? weekLabel(summary.report) : 'No completed report in this Location context.' }}</span></div>
      <div v-if="summary" class="lp-metrics">
        <article v-for="metric in metricCards" :key="metric.key" class="lp-card" :class="{primary: metric.key==='membershipConversionRate' || metric.key==='weeklyChurnRate'}">
          <span>{{ metric.label }}</span><strong>{{ displayMetric(metric.key, metric.current) }}</strong>
          <small v-if="summary.average.available">{{ averageLine(metric) }}</small>
          <small v-else>{{ summary.average.completedCount }} of {{ summary.average.requiredCount }} completed reports for average</small>
          <small>{{ goalLine(metric.key) }}</small>
        </article>
      </div>

      <div class="lp-tabs">
        <button v-for="tab in tabs" :key="tab.key" class="nav-button" :class="{active: section===tab.key}" @click="section=tab.key">{{ tab.label }}</button>
      </div>

      <form v-if="section==='submit' && canWrite" class="lp-card form-grid" @submit.prevent="submitReport">
        <div class="full-span"><h3>{{ correctionMode ? 'Correct Weekly Report' : 'Submit Weekly Report' }}</h3><p class="muted">Enter figures from the client’s authoritative source. Derived rates are calculated by MPP.</p></div>
        <label>Week Start<input v-model="form.weekStart" type="date" required @change="loadPrefill" /></label>
        <label>Beginning Active Memberships<input v-model.number="form.beginningActiveMemberships" type="number" min="0" step="1" required /></label>
        <label>Ending Active Memberships<input v-model.number="form.endingActiveMemberships" type="number" min="0" step="1" required /></label>
        <label>New Membership Sales<input v-model.number="form.newMembershipSales" type="number" min="0" step="1" required /></label>
        <label>Retail Lane Cars<input v-model.number="form.retailLaneCars" type="number" min="0" step="1" required /></label>
        <label>Cancellations During Period<input v-model.number="form.cancellationsDuringPeriod" type="number" min="0" step="1" required /></label>
        <label>Weekly Earnings / Gross Location Revenue<input v-model.number="form.grossRevenue" type="number" min="0" step="0.01" required /></label>
        <label>Source type<input v-model.trim="form.sourceType" maxlength="80" required placeholder="Client POS report" /></label>
        <label>Source reference<input v-model.trim="form.sourceReference" maxlength="500" placeholder="Optional report reference" /></label>
        <label class="full-span">Notes<textarea v-model="form.notes" maxlength="4000" rows="3"></textarea></label>
        <label v-if="correctionMode" class="full-span">Correction reason<textarea v-model.trim="correctionReason" required maxlength="1000" rows="2"></textarea></label>
        <div class="full-span lp-derived"><span>Conversion: {{ previewConversion }}</span><span>Churn: {{ previewChurn }}</span></div>
        <div class="full-span form-actions"><button class="primary-button" :disabled="saving">{{ saving ? 'Saving…' : correctionMode ? 'Save correction' : 'Submit weekly report' }}</button><button v-if="correctionMode" type="button" class="secondary-button" @click="cancelCorrection">Cancel</button></div>
      </form>

      <section v-if="section==='history'" class="lp-card">
        <div class="lp-heading"><h3>Weekly Reports</h3><button class="secondary-button" @click="loadHistory">Refresh</button></div>
        <table v-if="history.length" class="data-table"><thead><tr><th>Week</th><th>Conversion</th><th>Churn</th><th>Revenue</th><th></th></tr></thead><tbody>
          <tr v-for="r in history" :key="r.report_id"><td>{{ weekLabel(r) }}</td><td>{{ rate(derived(r).membershipConversionRate) }}</td><td>{{ rate(derived(r).weeklyChurnRate) }}</td><td>{{ money(r.gross_location_revenue_minor) }}</td><td><button class="secondary-button" @click="openDetail(r.report_id)">Open</button></td></tr>
        </tbody></table><p v-else class="muted">No submitted reports.</p>
        <article v-if="detail" class="lp-detail"><h3>Report Detail</h3><p>{{ weekLabel(detail.report) }} · Version {{ detail.report.report_version }}</p><p>Beginning {{ detail.report.beginning_active_memberships }} · Ending {{ detail.report.ending_active_memberships }} · Sales {{ detail.report.new_membership_sales }} · Retail Lane Cars {{ detail.report.retail_lane_cars }} · Cancellations {{ detail.report.cancellations_during_period }} · Revenue {{ money(detail.report.gross_location_revenue_minor) }}</p><p class="muted">Source: {{ detail.report.source_type }}<template v-if="detail.report.source_reference"> · {{ detail.report.source_reference }}</template></p><p class="muted">{{ detail.events.length }} durable submit/correction event(s)</p><button v-if="canWrite" class="secondary-button" @click="beginCorrection">Correct report</button></article>
      </section>

      <section v-if="section==='settings'" class="lp-card">
        <h3>Goals & Average Settings</h3><p class="muted">Goals are independently established for this Location. Retail Lane Cars has no V1 goal.</p>
        <form v-if="canWrite" class="form-grid" @submit.prevent="saveGoal">
          <label>Measure<select v-model="goalForm.type"><option v-for="g in goalOptions" :key="g.type" :value="g.type">{{ g.label }}</option></select></label>
          <label>{{ goalForm.type==='weekly_churn_rate' ? 'Churn Ceiling' : 'Goal' }}<input v-model.number="goalForm.displayValue" type="number" min="0" step="0.01" required /></label>
          <label>Effective week<input v-model="goalForm.effectiveFrom" type="date" required /></label>
          <div class="full-span form-actions"><button class="primary-button">Set Goal / Change Goal</button></div>
        </form>
        <form v-if="canWrite" class="form-grid lp-setting" @submit.prevent="saveAverage">
          <label>Completed weekly reports<input v-model.number="averageCount" type="number" min="2" max="52" step="1" required /></label>
          <div class="form-actions"><button class="secondary-button">Save {{ averageCount }}-Week Average</button></div>
        </form>
      </section>
    </template>
    <p v-if="message" :class="message.startsWith('Error:') ? 'error' : 'muted'">{{ message }}</p>
  </section>
</template>

<script>
export default {
  name: 'LocationPerformance',
  props: { api: { type: Function, required: true }, selectedScopeLocation: String, selectedScopeName: String, scopeLocations: Array, role: String },
  emits: ['select-location'],
  data() {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay()+6)%7))
    const week = d.toISOString().slice(0,10)
    return { section:'submit', summary:null, history:[], detail:null, glance:[], saving:false, message:'', averageCount:8, prefill:null, correctionMode:false, correctionReason:'', form:{weekStart:week,beginningActiveMemberships:0,endingActiveMemberships:0,newMembershipSales:0,retailLaneCars:0,cancellationsDuringPeriod:0,grossRevenue:0,sourceType:'Client POS report',sourceReference:'',notes:''}, goalForm:{type:'membership_conversion_rate',displayValue:15,effectiveFrom:week} }
  },
  computed: {
    canWrite(){ return this.role==='general_manager' },
    isPortfolio(){ return (this.role==='regional_manager'||this.role==='owner') && (this.scopeLocations?.length||0)>1 },
    tabs(){ const t=[]; if(this.canWrite)t.push({key:'submit',label:'Submit Report'}); t.push({key:'history',label:'History'}); if(this.canWrite)t.push({key:'settings',label:'Goals & Average'}); return t },
    metricCards(){ if(!this.summary)return[]; const m=this.summary.metrics,a=this.summary.average.metrics||{}; return [
      {key:'membershipConversionRate',label:'Membership Conversion Rate',current:m.membershipConversionRate,avg:a.membershipConversionRate},
      {key:'weeklyChurnRate',label:'Weekly Churn Rate',current:m.weeklyChurnRate,avg:a.weeklyChurnRate},
      {key:'newMembershipSales',label:'New Membership Sales',current:m.newMembershipSales,avg:a.newMembershipSales},
      {key:'activeMemberships',label:'Active Memberships',current:m.activeMemberships,avg:a.activeMemberships},
      {key:'weeklyEarningsMinor',label:'Weekly Earnings',current:m.weeklyEarningsMinor,avg:a.weeklyEarningsMinor},
      {key:'retailLaneCars',label:'Retail Lane Cars',current:m.retailLaneCars,avg:a.retailLaneCars}
    ]},
    goalOptions(){return [{type:'membership_conversion_rate',label:'Membership Conversion Rate'},{type:'new_membership_sales',label:'New Membership Sales'},{type:'active_memberships',label:'Active Memberships'},{type:'gross_location_revenue',label:'Weekly Earnings / Gross Location Revenue'},{type:'weekly_churn_rate',label:'Weekly Churn Rate'}]},
    previewConversion(){return this.form.retailLaneCars===0?'—':this.rate(this.form.newMembershipSales/this.form.retailLaneCars)},
    previewChurn(){return this.form.beginningActiveMemberships===0?'—':this.rate(this.form.cancellationsDuringPeriod/this.form.beginningActiveMemberships)}
  },
  watch:{ selectedScopeLocation(){this.refresh()} },
  mounted(){ this.refresh() },
  methods:{
    payload(extra={}){return{selectedScopeLocation:this.selectedScopeLocation,...extra}},
    async refresh(){this.message='';try{if(this.isPortfolio){const x=await this.api('/location-performance/locations/glance',{locationIds:(this.scopeLocations||[]).map(x=>x.locationId)});this.glance=x.locations||[]}else{const [s,h,a]=await Promise.all([this.api('/location-performance/summary',this.payload()),this.api('/location-performance/reports/history',this.payload()),this.api('/location-performance/average-settings',this.payload())]);this.summary=s.summary;this.history=h.reports||[];this.averageCount=a.setting.reportCount;if(!this.canWrite)this.section='history'}}catch(e){this.message='Error: '+e.message}},
    async loadHistory(){const h=await this.api('/location-performance/reports/history',this.payload());this.history=h.reports||[]},
    async loadPrefill(){try{const x=await this.api('/location-performance/reports/prefill',this.payload({weekStart:this.form.weekStart}));this.prefill=x.prefill;if(x.prefill){this.form.beginningActiveMemberships=x.prefill.ending_active_memberships;this.message='Beginning Active Memberships prefilled from the prior Ending value. Confirm or correct against the source.'}}catch(e){this.message='Error: '+e.message}},
    reportPayload(){return{...this.payload(),weekStart:this.form.weekStart,timezoneSnapshot:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',beginningActiveMemberships:Number(this.form.beginningActiveMemberships),endingActiveMemberships:Number(this.form.endingActiveMemberships),newMembershipSales:Number(this.form.newMembershipSales),retailLaneCars:Number(this.form.retailLaneCars),cancellationsDuringPeriod:Number(this.form.cancellationsDuringPeriod),grossLocationRevenueMinor:Math.round(Number(this.form.grossRevenue)*100),currency:'USD',notes:this.form.notes,sourceType:this.form.sourceType,sourceReference:this.form.sourceReference}},
    async submitReport(){this.saving=true;this.message='';try{if(this.correctionMode){await this.api('/location-performance/reports/correct',{...this.reportPayload(),reportId:this.detail.report.report_id,reason:this.correctionReason,expectedVersion:this.detail.report.report_version,actionId:crypto.randomUUID()})}else{await this.api('/location-performance/reports/submit',{...this.reportPayload(),priorReportId:this.prefill?.report_id||null,prefilledBeginningActiveMemberships:this.prefill?Number(this.prefill.ending_active_memberships):null,actionId:crypto.randomUUID()})}this.message=this.correctionMode?'Correction saved with audit event.':'Weekly report submitted.';this.cancelCorrection();await this.refresh()}catch(e){this.message='Error: '+e.message}finally{this.saving=false}},
    async openDetail(id){try{this.detail=await this.api('/location-performance/reports/detail',this.payload({reportId:id}))}catch(e){this.message='Error: '+e.message}},
    beginCorrection(){const r=this.detail.report;this.form={weekStart:r.week_start_date,beginningActiveMemberships:r.beginning_active_memberships,endingActiveMemberships:r.ending_active_memberships,newMembershipSales:r.new_membership_sales,retailLaneCars:r.retail_lane_cars,cancellationsDuringPeriod:r.cancellations_during_period,grossRevenue:r.gross_location_revenue_minor/100,sourceType:r.source_type,sourceReference:r.source_reference||'',notes:r.notes||''};this.correctionMode=true;this.correctionReason='';this.section='submit'},
    cancelCorrection(){this.correctionMode=false;this.correctionReason='';this.detail=null},
    async saveGoal(){try{const rateType=['membership_conversion_rate','weekly_churn_rate'].includes(this.goalForm.type),currency=this.goalForm.type==='gross_location_revenue'?'USD':undefined,value=rateType?Number(this.goalForm.displayValue)/100:this.goalForm.type==='gross_location_revenue'?Math.round(Number(this.goalForm.displayValue)*100):Number(this.goalForm.displayValue);await this.api('/location-performance/goals/set',this.payload({goalType:this.goalForm.type,value,currency,effectiveFrom:this.goalForm.effectiveFrom,expectedVersion:null,actionId:crypto.randomUUID()}));this.message='Goal saved.';await this.refresh()}catch(e){this.message='Error: '+e.message}},
    async saveAverage(){try{const current=await this.api('/location-performance/average-settings',this.payload());await this.api('/location-performance/average-settings/set',this.payload({reportCount:Number(this.averageCount),expectedVersion:current.setting.version,actionId:crypto.randomUUID()}));this.message='Average setting saved.';await this.refresh()}catch(e){this.message='Error: '+e.message}},
    derived(r){return{membershipConversionRate:r.retail_lane_cars===0?null:r.new_membership_sales/r.retail_lane_cars,weeklyChurnRate:r.beginning_active_memberships===0?null:r.cancellations_during_period/r.beginning_active_memberships}},
    goalLine(key){if(key==='retailLaneCars')return'No V1 goal';const map={membershipConversionRate:'membership_conversion_rate',weeklyChurnRate:'weekly_churn_rate',newMembershipSales:'new_membership_sales',activeMemberships:'active_memberships',weeklyEarningsMinor:'gross_location_revenue'},g=(this.summary?.goals||[]).find(x=>x.goal_type===map[key]);if(!g)return key==='weeklyChurnRate'?'Churn Ceiling not set':'Goal not set';return(key==='weeklyChurnRate'?'Churn Ceiling ':'Goal ')+this.displayMetric(key,g.goal_value)},
    averageLine(m){const d=m.avg?.relativeDifference;if(d===null||d===undefined)return this.summary.average.requiredCount+'-Week Average unavailable';return Math.abs(d*100).toFixed(1)+'% '+(d>=0?'above ':'below ')+this.summary.average.requiredCount+'-Week Average'},
    displayMetric(k,v){if(v===null||v===undefined)return'—';if(k==='membershipConversionRate'||k==='weeklyChurnRate')return this.rate(v);if(k==='weeklyEarningsMinor')return this.money(v);return Number(v).toLocaleString()},
    rate(v){return v===null||v===undefined?'—':(Number(v)*100).toFixed(1)+'%'},
    money(v){return v===null||v===undefined?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(v)/100)},
    weekLabel(r){return r.week_start_date+' → '+r.week_end_date},
    locationName(id){return(this.scopeLocations||[]).find(x=>x.locationId===id)?.name||id}
  }
}
</script>

<style scoped>
.lp-shell{display:grid;gap:16px}.lp-heading,.lp-report-state,.lp-location,.lp-derived{display:flex;align-items:center;justify-content:space-between;gap:12px}.lp-heading h2,.lp-heading h3,.lp-card h3{margin:0}.lp-card{background:#fff;border:1px solid #dfe5ec;border-radius:14px;padding:18px}.lp-card.primary{border-color:#7597bf;box-shadow:0 0 0 1px #d4e2f1}.lp-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.lp-metrics article{display:grid;gap:7px}.lp-metrics strong{font-size:25px}.lp-metrics small{color:#697586}.lp-tabs{display:flex;gap:8px;flex-wrap:wrap}.lp-detail{border-top:1px solid #dfe5ec;margin-top:18px;padding-top:18px}.lp-setting{border-top:1px solid #dfe5ec;margin-top:18px;padding-top:18px}.lp-location{margin-bottom:10px}.lp-location>div:first-child{flex:1}@media(max-width:760px){.lp-metrics{grid-template-columns:1fr}.lp-heading,.lp-location{align-items:flex-start;flex-direction:column}}
</style>
