<template>
  <section class="people-shell">
    <p v-if="error" class="people-message people-error">{{ error }}</p>
    <p v-if="loading" class="people-message">Loading People & Access…</p>

    <PeopleList
      v-else-if="view === 'list'"
      :people="people"
      :location-name="selectedScopeName"
      :can-invite="canInvite"
      @open="openPerson"
      @invite="openInvite"
      @refresh="loadList"
    />

    <PersonDetail
      v-else-if="view === 'detail' && selectedPerson"
      :person="selectedPerson"
      :lookups="lookups"
      :busy="saving"
      @back="returnToList"
      @save-relationships="saveRelationships"
      @change-access="changeAccess"
    />

    <InvitePerson
      v-else-if="view === 'invite'"
      :lookups="lookups"
      :busy="saving"
      :location-name="selectedScopeName"
      @back="returnToList"
      @invite="invitePerson"
    />

    <p v-if="actionMessage" class="people-message" aria-live="polite">{{ actionMessage }}</p>
  </section>
</template>

<script>
import PeopleList from './PeopleList.vue'
import PersonDetail from './PersonDetail.vue'
import InvitePerson from './InvitePerson.vue'

export default {
  name: 'PeopleAccess',
  components: { PeopleList, PersonDetail, InvitePerson },
  props: {
    api: { type: Function, required: true },
    selectedScopeLocation: { type: String, required: true },
    selectedScopeName: { type: String, default: '' },
    canManage: { type: Boolean, default: false }
  },
  data() {
    return { view: 'list', people: [], lookups: { locations: [], teams: [] }, selectedPerson: null, loading: true, saving: false, error: '', actionMessage: '', canInvite: false }
  },
  watch: {
    selectedScopeLocation() { this.resetAndLoad() }
  },
  mounted() { this.resetAndLoad() },
  methods: {
    async resetAndLoad() {
      this.view = 'list'; this.selectedPerson = null; this.error = ''; this.actionMessage = ''
      await Promise.all([this.loadList(), this.loadLookups()])
    },
    async loadList() {
      this.loading = true; this.error = ''
      try {
        const result = await this.api('/people', { selectedScopeLocation: this.selectedScopeLocation })
        this.people = (result.people || []).map(this.normalizeSummary)
        this.canInvite = this.canManage && result.allowedActions?.invite !== false
      } catch (error) { this.error = error.message } finally { this.loading = false }
    },
    async loadLookups() {
      try { this.lookups = await this.api('/people/lookups', { selectedScopeLocation: this.selectedScopeLocation }) }
      catch (error) { this.error = error.message }
    },
    async openPerson(personId) {
      this.loading = true; this.error = ''; this.actionMessage = ''
      try {
        const result = await this.api('/people/detail', { selectedScopeLocation: this.selectedScopeLocation, personId })
        this.selectedPerson = this.normalizeDetail(result)
        this.view = 'detail'
      } catch (error) { this.error = error.message } finally { this.loading = false }
    },
    openInvite() { this.actionMessage = ''; this.view = 'invite' },
    async returnToList() { this.selectedPerson = null; this.view = 'list'; await this.loadList() },
    async saveRelationships(payload) {
      this.saving = true; this.actionMessage = ''
      try {
        const result = await this.api('/people/relationships', { selectedScopeLocation: this.selectedScopeLocation, personId: this.selectedPerson.personId, expectedVersion: this.selectedPerson.version, actionId: crypto.randomUUID(), ...payload })
        this.selectedPerson = result.person ? this.normalizeDetail(result) : this.selectedPerson
        this.actionMessage = 'Relationships updated.'
      } catch (error) {
        this.actionMessage = error.message
        if (String(error.message).toLowerCase().includes('version') || String(error.message).toLowerCase().includes('changed')) await this.openPerson(this.selectedPerson.personId)
      } finally { this.saving = false }
    },
    async changeAccess(nextState) {
      this.saving = true; this.actionMessage = ''
      try {
        await this.api('/people/access-state', { selectedScopeLocation: this.selectedScopeLocation, personId: this.selectedPerson.personId, state: nextState.toLowerCase(), expectedVersion: this.selectedPerson.version, actionId: crypto.randomUUID(), reason: nextState === 'Active' ? 'Reactivate MPP access' : 'Deactivate MPP access' })
        await this.openPerson(this.selectedPerson.personId)
        this.actionMessage = nextState === 'Active' ? 'MPP access reactivated.' : 'MPP access deactivated. Historical records were retained.'
      } catch (error) { this.actionMessage = error.message } finally { this.saving = false }
    },
    async invitePerson(payload) {
      this.saving = true; this.actionMessage = ''
      try {
        const result = await this.api('/people/invite', { selectedScopeLocation: this.selectedScopeLocation, actionId: crypto.randomUUID(), ...payload })
        this.actionMessage = `Invitation started for ${result.person?.displayName || payload.displayName}.`
        await this.returnToList()
      } catch (error) { this.actionMessage = error.message } finally { this.saving = false }
    },
    normalizeSummary(person) {
      return { ...person, personId: person.personId || person.person_id, displayName: person.displayName || person.display_name, email: person.email || person.email_alias, primaryResponsibility: person.primaryResponsibility || person.responsibility, accessState: this.stateLabel(person.accessState || person.access_state) }
    },
    normalizeDetail(result) {
      const source = result.person || {}
      const lookupName = (type, id) => (this.lookups[type] || []).find(item => (item.id || item.locationId || item.teamId) === id)?.name || id
      const locations = result.locations || source.locationAccess || []
      const managed = result.managedTeams || source.managedTeams || (source.managedTeam ? [source.managedTeam] : [])
      const visibility = result.teamVisibility || source.teamVisibility || []
      return {
        ...source,
        personId: source.personId || source.person_id,
        displayName: source.displayName || source.display_name,
        email: source.email || source.email_alias,
        primaryResponsibility: source.primaryResponsibility || source.responsibility,
        accessState: this.stateLabel(source.accessState || source.access_state),
        version: Number(source.version || 0),
        locationAccess: locations.filter(item => !item.state || item.state === 'active').map(item => ({ id: item.id || item.locationId || item.location_id, name: item.name || lookupName('locations', item.id || item.locationId || item.location_id) })),
        managedTeam: managed.filter(item => !item.state || item.state === 'active').map(item => ({ id: item.id || item.teamId || item.team_id, name: item.name || lookupName('teams', item.id || item.teamId || item.team_id) }))[0] || null,
        teamVisibility: visibility.filter(item => !item.state || item.state === 'active').map(item => ({ id: item.id || item.teamId || item.team_id, name: item.name || lookupName('teams', item.id || item.teamId || item.team_id) })),
        allowedActions: result.allowedActions || source.allowedActions || { editRelationships: this.canManage, deactivate: this.canManage, reactivate: this.canManage },
        auditSummary: result.auditSummary || source.auditSummary || null
      }
    },
    stateLabel(value) {
      const state = String(value || 'invited').toLowerCase()
      return state.charAt(0).toUpperCase() + state.slice(1)
    }
  }
}
</script>

<style scoped>
.people-shell{display:grid;gap:14px}.people-message{margin:0;padding:12px 14px;border:1px solid #dfe5ec;border-radius:10px;background:#fff}.people-error{color:#b42318;border-color:#f1b8b4;background:#fff7f6}
</style>
