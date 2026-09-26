<template>
  <section class="person-card">
    <header class="person-heading"><button class="secondary-button" @click="$emit('back')">Back to People</button><span class="access-chip" :class="stateClass(person.accessState)">{{ person.accessState }}</span></header>
    <p class="eyebrow">Person</p><h2>{{ person.displayName }}</h2><p class="muted">{{ person.email || 'No email shown' }}</p>

    <div class="detail-grid">
      <article><span>Primary Responsibility</span><strong>{{ label(person.primaryResponsibility) }}</strong></article>
      <article><span>Location access</span><strong>{{ names(person.locationAccess) }}</strong></article>
      <article><span>Team managed</span><strong>{{ person.managedTeam?.name || '—' }}</strong></article>
      <article><span>Teams visible</span><strong>{{ names(person.teamVisibility) }}</strong></article>
    </div>

    <RelationshipEditor v-if="canEdit" :person="person" :lookups="lookups" :busy="busy" @save="$emit('save-relationships', $event)" />

    <section v-if="canChangeAccess" class="access-action">
      <div><h3>MPP access</h3><p class="muted">Deactivation prevents access without deleting Activity Reports, goals, reviews or audit history.</p></div>
      <button v-if="person.accessState === 'Active' && person.allowedActions?.deactivate" class="danger-button" :disabled="busy" @click="confirmDeactivate">Deactivate access</button>
      <button v-else-if="person.accessState === 'Inactive' && person.allowedActions?.reactivate" class="primary-button" :disabled="busy" @click="$emit('change-access', 'Active')">Reactivate access</button>
      <p v-else-if="person.accessState === 'Invited'" class="muted">Invitation pending activation.</p>
    </section>
    <p v-if="person.auditSummary" class="audit-copy">Changed {{ person.auditSummary.changedAt }} · {{ person.auditSummary.changedBy }}</p>
  </section>
</template>

<script>
import RelationshipEditor from './RelationshipEditor.vue'
export default {
  name: 'PersonDetail', components: { RelationshipEditor }, emits: ['back', 'save-relationships', 'change-access'],
  props: { person: { type: Object, required: true }, lookups: { type: Object, default: () => ({ locations: [], teams: [] }) }, busy: { type: Boolean, default: false } },
  computed: { canEdit() { return !!this.person.allowedActions?.editRelationships }, canChangeAccess() { return this.person.accessState === 'Invited' || !!(this.person.allowedActions?.deactivate || this.person.allowedActions?.reactivate) } },
  methods: {
    label(value) { return String(value || 'Unassigned').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase()) },
    names(values) { const items = Array.isArray(values) ? values : []; return items.length ? items.map(item => item.name || item.locationName || item.teamName || item.id).join(', ') : '—' },
    stateClass(value) { return `state-${String(value || '').toLowerCase()}` },
    confirmDeactivate() { if (window.confirm(`Deactivate MPP access for ${this.person.displayName}? Historical records will be retained.`)) this.$emit('change-access', 'Inactive') }
  }
}
</script>

<style scoped>
.person-card{padding:22px;background:#fff;border:1px solid #dfe5ec;border-radius:14px}.person-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}.person-card h2{margin:0}.detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:20px 0}.detail-grid article{padding:14px;background:#f7f9fb;border-radius:10px}.detail-grid span{display:block;color:#697586;font-size:12px;margin-bottom:6px}.access-action{display:flex;justify-content:space-between;align-items:center;gap:18px;margin-top:22px;padding-top:20px;border-top:1px solid #e4e9ef}.access-action h3{margin:0 0 6px}.access-action p{margin:0;max-width:620px}.danger-button{border:0;border-radius:9px;padding:10px 14px;background:#fde8e8;color:#9b1c1c;font-weight:800;cursor:pointer;min-height:44px}.access-chip{display:inline-flex;border-radius:999px;padding:6px 10px;font-size:12px;font-weight:800}.state-active{background:#dff7e9;color:#17643a}.state-inactive{background:#fde8e8;color:#9b1c1c}.state-invited{background:#fff3cd;color:#7a5500}.audit-copy{margin:18px 0 0;color:#697586;font-size:12px}@media(max-width:760px){.person-card{padding:18px}.detail-grid{grid-template-columns:1fr}.access-action{align-items:flex-start;flex-direction:column}.access-action button{width:100%}}
</style>
