<template>
  <main class="probe-shell">
    <section class="probe-card">
      <p class="eyebrow">MPP-P017</p>
      <h1>HighLevel User Context Probe</h1>

      <p v-if="loading">
        Requesting secured HighLevel viewer context...
      </p>

      <p v-else-if="error" class="error">
        {{ error }}
      </p>

      <template v-else>
        <dl>
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

        <section class="assignment-section">
          <h2>MPP Assignment</h2>
          <dl v-if="assignment && assignment.assignmentFound">
            <div>
              <dt>MPP Role</dt>
              <dd>{{ assignment.assignment.mpp_role || '—' }}</dd>
            </div>
            <div>
              <dt>Scope Type</dt>
              <dd>{{ assignment.assignment.scope_type || '—' }}</dd>
            </div>
            <div>
              <dt>Active</dt>
              <dd>{{ assignment.assignment.active || '—' }}</dd>
            </div>
            <div>
              <dt>Assignment Name</dt>
              <dd>{{ assignment.assignment.assignment_name || '—' }}</dd>
            </div>
                        <div>
                                        <dt>Assignment GHL User ID</dt>
                                        <dd>{{ assignment.assignment.ghl_user_id || '—' }}</dd>
                                      </div>
          </dl>
          <p v-else-if="assignment && assignment.error" class="error">
            Assignment error: {{ assignment.error }}
          </p>
          <p v-else-if="assignment" class="no-assignment">
            No MPP assignment found for this user (searched {{ assignment.totalSearched }} records).
          </p>
          <p v-else class="no-assignment">
            Assignment lookup unavailable.
          </p>
        </section>
      </template>
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
      context: {},
      assignment: null
    }
  },
  async mounted() {
    try {
      // Get raw SSO key from GHL parent frame
      const ssoKey = await new Promise((resolve) => {
        window.parent.postMessage({ message: "REQUEST_USER_DATA" }, "*");
        window.addEventListener("message", ({ data }) => {
          if (data.message === "REQUEST_USER_DATA_RESPONSE") {
            resolve(data.payload);
          }
        });
      });

      // Decrypt context for display
      const ctxRes = await fetch('/decrypt-sso', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: ssoKey })
      });
      this.context = await ctxRes.json();

      // P017: server-side assignment lookup — sends raw SSO key only
      const assignRes = await fetch('/assignment-context', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: ssoKey })
      });
      this.assignment = await assignRes.json();

    } catch (error) {
      console.error('MPP-P017 context probe failed', error);
      this.error = 'Unable to retrieve secured HighLevel user context.';
    } finally {
      this.loading = false;
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
  place-items: start center;
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
h2 {
  margin: 24px 0 12px;
  font-size: 18px;
  border-top: 2px solid #e5e7eb;
  padding-top: 20px;
}
.error {
  font-weight: 700;
  color: #dc2626;
}
.no-assignment {
  color: #6b7280;
  font-style: italic;
}
.assignment-section {
  margin-top: 8px;
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
