<template>
  <main class="app-shell">
    <section class="app-card">
      <header class="app-header">
        <div>
          <p class="eyebrow">MPP V1</p>
          <h1>Membership Performance Platform</h1>
          <p v-if="context.userName" class="subhead">
            {{ context.userName }} · {{ roleLabel }} · {{ context.activeLocation }}
          </p>
        </div>
        <span v-if="assignmentFound" class="status-pill" :class="isActive ? 'active' : 'inactive'">
          {{ isActive ? 'Active' : 'Inactive' }}
        </span>
      </header>

      <p v-if="loading" class="message">Loading your MPP workspace…</p>
      <p v-else-if="error" class="message error">{{ error }}</p>

      <template v-else-if="!assignmentFound">
        <section class="empty-state">
          <p class="eyebrow">MPP Access</p>
          <h2>Activate your assignment</h2>
          <p class="muted">Enter the record ID for your own active MPP User Assignment.</p>
          <form class="form-grid" @submit.prevent="provisionAssignment">
            <label class="full-span">MPP User Assignment record ID<input v-model.trim="provisionRecordId" required /></label>
            <div class="full-span form-actions">
              <button class="primary-button" :disabled="saving">Activate MPP access</button>
              <span>{{ actionMessage }}</span>
            </div>
          </form>
        </section>
      </template>

      <template v-else>
        <section v-if="!isActive" class="empty-state"><h2>Assignment inactive</h2></section>
        <template v-else>
          <nav class="nav-strip">
            <button v-for="item in navItems" :key="item.key" class="nav-button" :class="{ selected: activeView === item.key }" @click="activeView = item.key">
              {{ item.label }}
            </button>
          </nav>

          <section v-if="activeView === 'overview'" class="panel-grid">
            <article class="metric-card"><span>Opportunities</span><strong>{{ rollup.totals?.opportunities || 0 }}</strong></article>
            <article class="metric-card"><span>Memberships Sold</span><strong>{{ rollup.totals?.memberships_sold || 0 }}</strong></article>
            <article class="metric-card"><span>Conversion</span><strong>{{ percent(rollup.totals?.conversionRate) }}</strong></article>
            <article class="metric-card"><span>Pending Review</span><strong>{{ rollup.totals?.pending_count || 0 }}</strong></article>

            <article v-if="locationGoal.goal" class="wide-card goal-card">
              <div class="section-heading">
                <div><p class="eyebrow">Location Goal</p><h2>{{ locationGoal.month }}</h2></div>
                <strong>{{ locationGoal.goal.memberships_target }} memberships · {{ percent(locationGoal.goal.conversion_target) }} conversion</strong>
              </div>
              <div class="goal-grid">
                <div><span>Actual sold</span><strong>{{ locationGoal.pace?.actual || 0 }}</strong></div>
                <div><span>Expected by today</span><strong>{{ locationGoal.pace?.expectedToDate || 0 }}</strong></div>
                <div><span>Variance</span><strong>{{ signed(locationGoal.pace?.variance) }}</strong></div>
                <div><span>Goal progress</span><strong>{{ percent(locationGoal.pace?.percentOfGoal) }}</strong></div>
              </div>
            </article>
            <article v-else class="wide-card"><p class="eyebrow">Location Goal</p><p class="muted">No location goal has been set for {{ selectedMonth }}.</p></article>

            <article v-if="role === 'seller' && rollup.sellerGoal?.conversionGoal !== null" class="wide-card personal-goal-card">
              <p class="eyebrow">My Conversion Goal</p>
              <div class="goal-grid three-column">
                <div><span>Goal</span><strong>{{ percent(rollup.sellerGoal.conversionGoal) }}</strong></div>
                <div><span>Actual</span><strong>{{ percent(rollup.totals?.conversionRate) }}</strong></div>
                <div><span>vs Goal</span><strong>{{ points(rollup.sellerGoal.conversionVariance) }}</strong></div>
              </div>
            </article>

            <article class="wide-card">
              <div class="section-heading">
                <div><p class="eyebrow">{{ rollup.scope === 'self' ? 'My performance' : 'Location performance' }}</p><h2>{{ rollup.month || selectedMonth }}</h2></div>
                <input v-model="selectedMonth" type="month" @change="changeMonth" />
              </div>
              <table v-if="rollup.sellers?.length" class="data-table">
                <thead><tr><th>Seller</th><th>Opportunities</th><th>Sold</th><th>Conversion</th><th>Goal</th><th>vs Goal</th><th>Pending</th></tr></thead>
                <tbody>
                  <tr v-for="seller in rollup.sellers" :key="seller.seller_user_id">
                    <td>{{ seller.seller_name }}</td>
                    <td>{{ seller.opportunities }}</td>
                    <td>{{ seller.memberships_sold }}</td>
                    <td>{{ percent(seller.conversionRate) }}</td>
                    <td>{{ seller.conversionGoal === null ? '—' : percent(seller.conversionGoal) }}</td>
                    <td>{{ seller.conversionVariance === null ? '—' : points(seller.conversionVariance) }}</td>
                    <td>{{ seller.pending_count }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="muted">No activity recorded for this month yet.</p>
            </article>
          </section>

          <section v-if="activeView === 'goals'" class="wide-card">
            <p class="eyebrow">P026A · Location Management</p><h2>Set Monthly Location Goal</h2>
            <form class="form-grid" @submit.prevent="saveLocationGoal">
              <label>Month<input v-model="goalForm.month" type="month" required /></label>
              <label>Membership target<input v-model.number="goalForm.membershipsTarget" type="number" min="0" step="1" required /></label>
              <label>Conversion target %<input v-model.number="goalForm.conversionPercent" type="number" min="0" max="100" step="0.1" required /></label>
              <div class="full-span form-actions"><button class="primary-button" :disabled="saving">{{ saving ? 'Saving…' : 'Save location goal' }}</button><span>{{ actionMessage }}</span></div>
            </form>
          </section>

          <section v-if="activeView === 'seller-goals'" class="wide-card">
            <p class="eyebrow">P026B · Seller Accountability</p><h2>Set Seller Conversion Goal</h2>
            <form class="form-grid" @submit.prevent="saveSellerGoal">
              <label>Month<input v-model="sellerGoalForm.month" type="month" required @change="syncSellerGoalMonth" /></label>
              <label>Seller
                <select v-model="sellerGoalForm.sellerUserId" required>
                  <option disabled value="">Choose seller</option>
                  <option v-for="seller in rollup.sellers" :key="seller.seller_user_id" :value="seller.seller_user_id">{{ seller.seller_name }}</option>
                </select>
              </label>
              <label>Conversion target %<input v-model.number="sellerGoalForm.conversionPercent" type="number" min="0" max="100" step="0.1" required /></label>
              <div class="full-span form-actions"><button class="primary-button" :disabled="saving">{{ saving ? 'Saving…' : 'Save seller goal' }}</button><span>{{ actionMessage }}</span></div>
            </form>
            <p v-if="!rollup.sellers?.length" class="muted">No sellers with activity are available for this month.</p>
          </section>

          <section v-if="activeView === 'submit'" class="wide-card">
            <p class="eyebrow">Seller Activity</p><h2>Submit Shift Log</h2>
            <form class="form-grid" @submit.prevent="submitShift">
              <label>Shift date<input v-model="shiftForm.shiftDate" type="date" required /></label>
              <label>Opportunities<input v-model.number="shiftForm.opportunities" type="number" min="0" required /></label>
              <label>Memberships sold<input v-model.number="shiftForm.membershipsSold" type="number" min="0" required /></label>
              <label class="full-span">Notes<textarea v-model="shiftForm.notes" rows="4"></textarea></label>
              <div class="full-span form-actions"><button class="primary-button" :disabled="saving">Submit shift</button><span>{{ actionMessage }}</span></div>
            </form>
          </section>

          <section v-if="activeView === 'history'" class="wide-card">
            <p class="eyebrow">Seller Activity</p><h2>My Recent Shifts</h2>
            <table v-if="shiftLogs.length" class="data-table">
              <thead><tr><th>Date</th><th>Opportunities</th><th>Sold</th><th>Conversion</th><th>Status</th></tr></thead>
              <tbody><tr v-for="log in shiftLogs" :key="log.id"><td>{{ shortDate(log.shift_date) }}</td><td>{{ log.opportunities }}</td><td>{{ log.memberships_sold }}</td><td>{{ percent(rate(log.memberships_sold, log.opportunities)) }}</td><td><span class="mini-pill">{{ log.status }}</span></td></tr></tbody>
            </table>
            <p v-else class="muted">No shift logs yet.</p>
          </section>

          <section v-if="activeView === 'review'" class="wide-card">
            <div class="section-heading"><div><p class="eyebrow">Manager Review</p><h2>Pending Shift Logs</h2></div><button class="secondary-button" @click="loadReviewQueue">Refresh</button></div>
            <div v-if="reviewQueue.length" class="review-list">
              <article v-for="log in reviewQueue" :key="log.id" class="review-item">
                <div><strong>{{ log.seller_name }}</strong><span>{{ shortDate(log.shift_date) }}</span><span>{{ log.memberships_sold }} sold / {{ log.opportunities }} opportunities · {{ percent(rate(log.memberships_sold, log.opportunities)) }}</span><small>{{ log.notes }}</small></div>
                <div class="review-actions"><button class="approve-button" @click="reviewLog(log.id, 'verified')">Verify</button><button class="reject-button" @click="reviewLog(log.id, 'rejected')">Reject</button></div>
              </article>
            </div>
            <p v-else class="muted">No shift logs are waiting for review.</p>
          </section>

          <section v-if="activeView === 'provision'" class="wide-card">
            <p class="eyebrow">MPP Administration</p><h2>Provision User Assignment</h2>
            <form class="form-grid" @submit.prevent="provisionAssignment">
              <label class="full-span">MPP User Assignment record ID<input v-model.trim="provisionRecordId" required /></label>
              <div class="full-span form-actions"><button class="primary-button" :disabled="saving">Provision assignment</button><span>{{ actionMessage }}</span></div>
            </form>
          </section>
        </template>
      </template>
    </section>
  </main>
</template>

<script>
export default {
  name: 'App',
  data() {
    const now = new Date()
    const month = now.toISOString().slice(0, 7)
    return {
      loading: true,
      saving: false,
      error: '',
      actionMessage: '',
      ssoKey: '',
      context: {},
      assignment: null,
      capabilities: [],
      activeView: 'overview',
      selectedMonth: month,
      rollup: { totals: {}, sellers: [], sellerGoal: null },
      locationGoal: { goal: null, pace: null },
      shiftLogs: [],
      reviewQueue: [],
      provisionRecordId: '',
      goalForm: { month, membershipsTarget: 100, conversionPercent: 20 },
      sellerGoalForm: { month, sellerUserId: '', conversionPercent: 30 },
      shiftForm: { shiftDate: now.toISOString().slice(0, 10), opportunities: 0, membershipsSold: 0, notes: '' }
    }
  },
  computed: {
    assignmentFound() { return !!this.assignment?.assignmentFound },
    role() { return this.assignment?.assignment?.mpp_role || '' },
    roleLabel() { return this.role ? this.role.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Unassigned' },
    isActive() { return String(this.assignment?.assignment?.active || '').toLowerCase() === 'yes' },
    navItems() {
      const items = [{ key: 'overview', label: 'Overview' }]
      if (this.capabilities.includes('manage_location_goal')) items.push({ key: 'goals', label: 'Location Goal' })
      if (this.capabilities.includes('manage_seller_goals')) items.push({ key: 'seller-goals', label: 'Seller Goals' })
      if (this.capabilities.includes('submit_shift')) items.push({ key: 'submit', label: 'Submit Shift' }, { key: 'history', label: 'My History' })
      if (this.capabilities.includes('review_logs')) items.push({ key: 'review', label: 'Review Queue' })
      if (this.capabilities.includes('provision_assignments')) items.push({ key: 'provision', label: 'Provision Users' })
      return items
    }
  },
  async mounted() {
    try {
      this.ssoKey = await this.requestSsoKey()
      const response = await fetch('/decrypt-sso', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: this.ssoKey }) })
      this.context = await response.json()
      await this.reloadAssignment()
    } catch (error) {
      this.error = error.message || 'Unable to load MPP workspace.'
    } finally {
      this.loading = false
    }
  },
  methods: {
    requestSsoKey() {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('HighLevel user context timed out.')), 10000)
        const handler = ({ data }) => {
          if (data?.message === 'REQUEST_USER_DATA_RESPONSE') {
            clearTimeout(timer)
            window.removeEventListener('message', handler)
            resolve(data.payload)
          }
        }
        window.addEventListener('message', handler)
        window.parent.postMessage({ message: 'REQUEST_USER_DATA' }, '*')
      })
    },
    async api(url, body = {}) {
      const response = await fetch(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ key: this.ssoKey, ...body }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`)
      return data
    },
    async reloadAssignment() {
      const assignment = await this.api('/assignment-context')
      this.assignment = assignment
      this.capabilities = assignment.capabilities || []
      if (assignment.assignmentFound && String(assignment.assignment?.active || '').toLowerCase() === 'yes') {
        await Promise.all([this.loadRollup(), this.loadLocationGoal()])
        if (this.capabilities.includes('submit_shift')) await this.loadShiftLogs()
        if (this.capabilities.includes('review_logs')) await this.loadReviewQueue()
      }
    },
    async changeMonth() {
      this.goalForm.month = this.selectedMonth
      this.sellerGoalForm.month = this.selectedMonth
      await Promise.all([this.loadRollup(), this.loadLocationGoal()])
    },
    async syncSellerGoalMonth() {
      this.selectedMonth = this.sellerGoalForm.month
      await this.loadRollup()
    },
    async loadRollup() {
      this.rollup = await this.api('/performance/rollup', { month: this.selectedMonth })
      if (!this.sellerGoalForm.sellerUserId && this.rollup.sellers?.length) this.sellerGoalForm.sellerUserId = this.rollup.sellers[0].seller_user_id
    },
    async loadLocationGoal() { this.locationGoal = await this.api('/goals/location', { month: this.selectedMonth }) },
    async saveLocationGoal() {
      this.saving = true
      this.actionMessage = ''
      try {
        await this.api('/goals/location/set', { month: this.goalForm.month, membershipsTarget: this.goalForm.membershipsTarget, conversionTarget: Number(this.goalForm.conversionPercent) / 100 })
        this.selectedMonth = this.goalForm.month
        await Promise.all([this.loadLocationGoal(), this.loadRollup()])
        this.actionMessage = 'Location goal saved.'
        this.activeView = 'overview'
      } catch (error) { this.actionMessage = error.message } finally { this.saving = false }
    },
    async saveSellerGoal() {
      this.saving = true
      this.actionMessage = ''
      try {
        await this.api('/goals/seller/set', { sellerUserId: this.sellerGoalForm.sellerUserId, month: this.sellerGoalForm.month, conversionTarget: Number(this.sellerGoalForm.conversionPercent) / 100 })
        this.selectedMonth = this.sellerGoalForm.month
        await this.loadRollup()
        this.actionMessage = 'Seller goal saved.'
        this.activeView = 'overview'
      } catch (error) { this.actionMessage = error.message } finally { this.saving = false }
    },
    async loadShiftLogs() { this.shiftLogs = (await this.api('/seller/shift-logs')).logs || [] },
    async loadReviewQueue() { this.reviewQueue = (await this.api('/manager/review-queue')).logs || [] },
    async submitShift() {
      this.saving = true
      try {
        await this.api('/seller/shift-log', this.shiftForm)
        this.shiftForm.opportunities = 0
        this.shiftForm.membershipsSold = 0
        this.shiftForm.notes = ''
        await Promise.all([this.loadShiftLogs(), this.loadRollup(), this.loadLocationGoal()])
      } catch (error) { this.actionMessage = error.message } finally { this.saving = false }
    },
    async reviewLog(id, decision) {
      await this.api('/manager/review-shift', { logId: id, decision })
      await Promise.all([this.loadReviewQueue(), this.loadRollup(), this.loadLocationGoal()])
    },
    async provisionAssignment() {
      this.saving = true
      const wasUnassigned = !this.assignmentFound
      try {
        const result = await this.api('/admin/assignment-provision', { recordId: this.provisionRecordId })
        this.actionMessage = result.mode === 'self' ? `MPP access activated for ${result.assignment.assignment_name}.` : `Provisioned ${result.assignment.assignment_name}.`
        this.provisionRecordId = ''
        if (wasUnassigned) await this.reloadAssignment()
      } catch (error) { this.actionMessage = error.message } finally { this.saving = false }
    },
    rate(sold, opportunities) { return Number(opportunities) > 0 ? Number(sold) / Number(opportunities) : 0 },
    percent(value) { return `${(Number(value || 0) * 100).toFixed(1)}%` },
    points(value) { const n = Number(value || 0) * 100; return `${n >= 0 ? '+' : ''}${n.toFixed(1)} pts` },
    signed(value) { const number = Number(value || 0); return `${number >= 0 ? '+' : ''}${number.toFixed(1)}` },
    shortDate(value) { return value ? String(value).slice(0, 10) : '—' }
  }
}
</script>

<style>
:root { font-family: Inter, Avenir, Helvetica, Arial, sans-serif; color: #172033; background: #eef2f6; }
* { box-sizing: border-box; }
body { margin: 0; background: #eef2f6; }
button, input, textarea, select { font: inherit; }
.app-shell { min-height: 100vh; padding: 28px; }
.app-card { max-width: 1080px; margin: 0 auto; }
.app-header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 22px; }
.eyebrow { margin: 0 0 6px; font-size: 11px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; color: #526071; }
h1 { margin: 0; font-size: 30px; line-height: 1.12; }
h2 { margin: 0; font-size: 20px; }
.subhead, .muted { color: #697586; }
.subhead { margin: 8px 0 0; }
.status-pill, .mini-pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 6px 10px; font-size: 12px; font-weight: 700; text-transform: capitalize; }
.status-pill.active { background: #dff7e9; color: #17643a; }
.status-pill.inactive { background: #fde8e8; color: #9b1c1c; }
.mini-pill { padding: 4px 8px; background: #eef2f6; }
.message, .empty-state, .wide-card, .metric-card { background: white; border: 1px solid #dfe5ec; border-radius: 14px; }
.message, .empty-state { padding: 24px; }
.error { color: #b42318; }
.nav-strip { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
.nav-button, .secondary-button { border: 1px solid #ccd5df; background: white; border-radius: 9px; padding: 9px 13px; cursor: pointer; font-weight: 700; color: #344054; }
.nav-button.selected { background: #172033; color: white; border-color: #172033; }
.panel-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.metric-card { padding: 18px; }
.metric-card span, .goal-grid span { display: block; color: #697586; font-size: 13px; margin-bottom: 8px; }
.metric-card strong { font-size: 28px; }
.wide-card { padding: 22px; grid-column: 1 / -1; }
.section-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 18px; }
.goal-card { border-width: 2px; }
.personal-goal-card { border-left: 4px solid #172033; }
.goal-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.goal-grid.three-column { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.goal-grid > div { padding: 12px; background: #f7f9fb; border-radius: 10px; }
.goal-grid strong { font-size: 20px; }
.form-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-top: 20px; }
.form-grid label { display: grid; gap: 7px; font-weight: 700; font-size: 13px; }
.full-span { grid-column: 1 / -1; }
input, textarea, select { width: 100%; border: 1px solid #cbd5df; border-radius: 9px; padding: 10px 11px; background: white; color: #172033; }
textarea { resize: vertical; }
.form-actions { display: flex; align-items: center; gap: 14px; }
.primary-button, .approve-button, .reject-button { border: 0; border-radius: 9px; padding: 10px 14px; cursor: pointer; font-weight: 800; }
.primary-button { background: #172033; color: white; }
.approve-button { background: #dff7e9; color: #17643a; }
.reject-button { background: #fde8e8; color: #9b1c1c; }
button:disabled { opacity: .55; cursor: wait; }
.data-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
.data-table th, .data-table td { border-top: 1px solid #e4e9ef; padding: 11px 9px; text-align: left; font-size: 13px; }
.data-table th { color: #697586; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
.review-list { display: grid; gap: 10px; }
.review-item { display: flex; justify-content: space-between; gap: 18px; padding: 14px; border: 1px solid #e4e9ef; border-radius: 10px; }
.review-item > div:first-child { display: grid; gap: 4px; }
.review-item span, .review-item small { color: #697586; }
.review-actions { display: flex; gap: 8px; align-items: center; }
@media (max-width: 760px) {
  .app-shell { padding: 16px; }
  .panel-grid, .goal-grid, .goal-grid.three-column { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .form-grid { grid-template-columns: 1fr; }
  .full-span { grid-column: 1; }
  .data-table { display: block; overflow-x: auto; }
  .review-item { flex-direction: column; }
}
</style>
