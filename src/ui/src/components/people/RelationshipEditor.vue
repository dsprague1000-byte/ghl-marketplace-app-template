<template>
  <form class="relationship-form" @submit.prevent="submit">
    <div><h3>Relationships & access</h3><p class="muted">These settings do not assign a permanent Activity Report Team.</p></div>
    <div class="fields">
      <label>Primary Responsibility<select v-model="form.primaryResponsibility" required><option value="seller">Seller</option><option value="sales_manager">Sales Manager</option><option value="general_manager">General Manager</option></select></label>
      <label>Location access<select v-model="form.locationIds" multiple required><option v-for="location in lookups.locations || []" :key="location.id || location.locationId" :value="location.id || location.locationId">{{ location.name || location.locationName }}</option></select></label>
      <label v-if="form.primaryResponsibility === 'sales_manager'">Team managed<select v-model="form.managedTeamId" required><option disabled value="">Choose Team</option><option v-for="team in lookups.teams || []" :key="team.id || team.teamId" :value="team.id || team.teamId">{{ team.name || team.teamName }}</option></select></label>
      <label>Teams this person may inspect<select v-model="form.teamVisibilityIds" multiple><option v-for="team in lookups.teams || []" :key="`visible-${team.id || team.teamId}`" :value="team.id || team.teamId">{{ team.name || team.teamName }}</option></select></label>
      <label class="full-span">Reason for change<textarea v-model.trim="form.reason" rows="3" maxlength="500" required></textarea></label>
    </div>
    <button class="primary-button" :disabled="busy">{{ busy ? 'Saving…' : 'Save relationship changes' }}</button>
  </form>
</template>

<script>
export default {
  name: 'RelationshipEditor', emits: ['save'], props: { person: { type: Object, required: true }, lookups: { type: Object, default: () => ({ locations: [], teams: [] }) }, busy: { type: Boolean, default: false } },
  data() { return { form: this.formFromPerson() } },
  watch: { person: { deep: true, handler() { this.form = this.formFromPerson() } } },
  methods: {
    formFromPerson() { return { primaryResponsibility: this.person.primaryResponsibility || 'seller', locationIds: (this.person.locationAccess || []).map(item => item.id || item.locationId), managedTeamId: this.person.managedTeam?.id || this.person.managedTeam?.teamId || '', teamVisibilityIds: (this.person.teamVisibility || []).map(item => item.id || item.teamId), reason: '' } },
    submit() { this.$emit('save', { ...this.form, managedTeamId: this.form.primaryResponsibility === 'sales_manager' ? this.form.managedTeamId : null }) }
  }
}
</script>

<style scoped>
.relationship-form{margin-top:22px;padding-top:20px;border-top:1px solid #e4e9ef}.relationship-form h3{margin:0 0 6px}.relationship-form p{margin:0}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:16px 0}.fields label{display:grid;gap:7px;font-size:13px;font-weight:700}.fields .full-span{grid-column:1/-1}select[multiple]{min-height:110px}@media(max-width:760px){.fields{grid-template-columns:1fr}.fields .full-span{grid-column:1}.relationship-form button{width:100%;min-height:44px}}
</style>
