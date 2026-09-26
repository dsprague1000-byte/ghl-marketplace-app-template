<template>
  <section class="people-card">
    <header class="people-heading">
      <div><p class="eyebrow">Organization</p><h2>People & Access</h2><p class="muted">{{ locationName }}</p></div>
      <div class="heading-actions"><button class="secondary-button" @click="$emit('refresh')">Refresh</button><button v-if="canInvite" class="primary-button" @click="$emit('invite')">Add / Invite Person</button></div>
    </header>
    <div v-if="people.length" class="people-list">
      <button v-for="person in people" :key="person.personId" class="person-row" @click="$emit('open', person.personId)">
        <span class="person-copy"><strong>{{ person.displayName }}</strong><small>{{ person.email || 'No email shown' }}</small><small>{{ relationshipSummary(person) }}</small></span>
        <span class="person-meta"><span class="responsibility">{{ responsibilityLabel(person.primaryResponsibility) }}</span><span class="access-chip" :class="stateClass(person.accessState)">{{ person.accessState }}</span></span>
      </button>
    </div>
    <p v-else class="muted empty-copy">No people are available in this Location scope.</p>
  </section>
</template>

<script>
export default {
  name: 'PeopleList',
  emits: ['open', 'invite', 'refresh'],
  props: { people: { type: Array, default: () => [] }, locationName: { type: String, default: '' }, canInvite: { type: Boolean, default: false } },
  methods: {
    responsibilityLabel(value) { return String(value || 'Unassigned').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase()) },
    stateClass(value) { return `state-${String(value || '').toLowerCase()}` },
    relationshipSummary(person) {
      if (person.managedTeam?.name) return `Manages ${person.managedTeam.name}`
      const count = Number(person.teamVisibilitySummary?.count || 0)
      if (count) return `May inspect ${count} Team${count === 1 ? '' : 's'}`
      return person.locationAccessSummary || 'Location access not shown'
    }
  }
}
</script>

<style scoped>
.people-card{padding:22px;background:#fff;border:1px solid #dfe5ec;border-radius:14px}.people-heading{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:18px}.people-heading h2{margin:0}.people-heading .muted{margin:7px 0 0}.heading-actions{display:flex;gap:8px;flex-wrap:wrap}.people-list{display:grid;gap:10px}.person-row{width:100%;display:flex;justify-content:space-between;align-items:center;gap:16px;padding:14px;border:1px solid #e4e9ef;border-radius:11px;background:#fff;color:#172033;text-align:left;cursor:pointer;min-height:64px}.person-row:hover{background:#f7f9fb}.person-copy,.person-meta{display:grid;gap:4px}.person-copy small{color:#697586}.person-meta{justify-items:end}.responsibility{font-size:12px;font-weight:800}.access-chip{display:inline-flex;border-radius:999px;padding:4px 8px;font-size:12px;font-weight:800}.state-active{background:#dff7e9;color:#17643a}.state-inactive{background:#fde8e8;color:#9b1c1c}.state-invited{background:#fff3cd;color:#7a5500}.empty-copy{margin:0}@media(max-width:760px){.people-card{padding:18px}.people-heading,.person-row{align-items:flex-start;flex-direction:column}.person-meta{justify-items:start}.heading-actions{width:100%}.heading-actions button{min-height:44px;flex:1}}
</style>
