<template>
  <section class="invite-card">
    <button class="secondary-button" @click="$emit('back')">Back to People</button>
    <p class="eyebrow invite-eyebrow">Add / Invite Person</p><h2>Identity and responsibility</h2><p class="muted">MPP sends an invitation through the approved account provider. Passwords are never collected here.</p>
    <form @submit.prevent="submit">
      <div class="fields">
        <label>Full name<input v-model.trim="form.displayName" maxlength="160" required /></label>
        <label>Email<input v-model.trim="form.email" type="email" maxlength="254" required /></label>
        <label>Primary Responsibility<select v-model="form.primaryResponsibility" required><option value="seller">Seller</option><option value="sales_manager">Sales Manager</option><option value="general_manager">General Manager</option></select></label>
        <label>Location access<select v-model="form.locationIds" multiple required><option v-for="location in lookups.locations || []" :key="location.id || location.locationId" :value="location.id || location.locationId">{{ location.name || location.locationName }}</option></select></label>
        <label v-if="form.primaryResponsibility === 'sales_manager'">Team managed<select v-model="form.managedTeamId" required><option disabled value="">Choose Team</option><option v-for="team in lookups.teams || []" :key="team.id || team.teamId" :value="team.id || team.teamId">{{ team.name || team.teamName }}</option></select></label>
        <label>Teams this person may inspect<select v-model="form.teamVisibilityIds" multiple><option v-for="team in lookups.teams || []" :key="`visible-${team.id || team.teamId}`" :value="team.id || team.teamId">{{ team.name || team.teamName }}</option></select></label>
      </div>
      <aside class="confirmation"><strong>Invitation summary</strong><span>{{ form.displayName || 'New person' }} · {{ responsibilityLabel }}</span><span>{{ locationName }}</span><small>Activity Report Team attribution remains a per-report choice.</small></aside>
      <button class="primary-button" :disabled="busy">{{ busy ? 'Starting invitation…' : 'Send invitation' }}</button>
    </form>
  </section>
</template>

<script>
export default {
  name: 'InvitePerson', emits: ['back', 'invite'], props: { lookups: { type: Object, default: () => ({ locations: [], teams: [] }) }, busy: { type: Boolean, default: false }, locationName: { type: String, default: '' } },
  data() { return { form: { displayName: '', email: '', primaryResponsibility: 'seller', locationIds: [], managedTeamId: '', teamVisibilityIds: [] } } },
  computed: { responsibilityLabel() { return this.form.primaryResponsibility.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase()) } },
  methods: { submit() { this.$emit('invite', { ...this.form, managedTeamId: this.form.primaryResponsibility === 'sales_manager' ? this.form.managedTeamId : null }) } }
}
</script>

<style scoped>
.invite-card{padding:22px;background:#fff;border:1px solid #dfe5ec;border-radius:14px}.invite-eyebrow{margin-top:22px}.invite-card h2{margin:0}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:20px 0}.fields label{display:grid;gap:7px;font-size:13px;font-weight:700}select[multiple]{min-height:110px}.confirmation{display:grid;gap:5px;margin:0 0 16px;padding:14px;border-radius:10px;background:#f7f9fb}.confirmation small{color:#697586}@media(max-width:760px){.invite-card{padding:18px}.fields{grid-template-columns:1fr}.invite-card form>.primary-button{width:100%;min-height:44px}}
</style>
