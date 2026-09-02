<template>
  <main class="probe-shell">
    <section class="probe-card">
      <p class="eyebrow">MPP-P016</p>
      <h1>HighLevel User Context Probe</h1>

      <p v-if="loading">
        Requesting secured HighLevel viewer context...
      </p>

      <p v-else-if="error" class="error">
        {{ error }}
      </p>

      <dl v-else>
        <div>
          <dt>Current Viewer</dt>
          <dd>{{ context.userName || 'Not returned' }}</dd>
        </div>

        <div>
          <dt>Trusted User ID</dt>
          <dd>{{ context.userId || 'Not returned' }}</dd>
        </div>

        <div>
          <dt>Active Location</dt>
          <dd>{{ context.activeLocation || 'Not returned' }}</dd>
        </div>

        <div>
          <dt>GHL Role</dt>
          <dd>{{ context.role || 'Not returned' }}</dd>
        </div>
      </dl>
    </section>
  </main>
</template>

<script>
export default {
  name: 'App',

  data() {
    return {
      loading: true,
      error: '',
      context: {}
    }
  },

  async mounted() {
    try {
      this.context = await window.ghl.getUserData()
    } catch (error) {
      console.error('MPP-P016 user context probe failed', error)
      this.error = 'Unable to retrieve secured HighLevel user context.'
    } finally {
      this.loading = false
    }
  }
}
</script>

<style>
#app {
  font-family: Avenir, Helvetica, Arial, sans-serif;
  color: #1f2937;
}

body {
  margin: 0;
  background: #f3f4f6;
}

.probe-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px;
  box-sizing: border-box;
}

.probe-card {
  width: min(680px, 100%);
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 28px;
  box-sizing: border-box;
}

.eyebrow {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
}

h1 {
  margin: 0 0 24px;
  font-size: 28px;
}

.error {
  font-weight: 700;
}

dl {
  margin: 0;
}

dl > div {
  display: grid;
  grid-template-columns: minmax(140px, 0.8fr) minmax(0, 1.8fr);
  gap: 16px;
  padding: 14px 0;
  border-top: 1px solid #e5e7eb;
}

dt {
  font-weight: 700;
}

dd {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
