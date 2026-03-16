(function () {
  const summaryEl = document.getElementById("summary");
  const recordedHashEl = document.getElementById("recorded-hash");
  const currentHashEl = document.getElementById("current-hash");
  const approvedHashEl = document.getElementById("approved-hash");
  const approvedByEl = document.getElementById("approved-by");
  const vIntegrityEl = document.getElementById("v-integrity");
  const vRecordedEl = document.getElementById("v-recorded");
  const vApprovedEl = document.getElementById("v-approved");
  const vStatusEl = document.getElementById("v-status");
  const verifyNoteEl = document.getElementById("verify-note");
  const logEl = document.getElementById("log");

  const defaultSummary = "Review exact file and shell changes, then approve hash";
  const state = {
    exists: false,
    summary: defaultSummary,
    recordedHash: null,
    currentHash: null,
    approvedHash: null,
    approvedBy: null
  };

  function fakeHash(input) {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return `pf_${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }

  function computeCurrentHash() {
    return fakeHash(`version:1|source:demo|summary:${state.summary}|ops:2|pre:2`);
  }

  function readVerify() {
    if (!state.exists) {
      return {
        integrityMetadataExists: false,
        recordedHashMatchesCurrent: false,
        approvalBoundToCurrentHash: false,
        status: "not-ready"
      };
    }

    return {
      integrityMetadataExists: Boolean(state.recordedHash),
      recordedHashMatchesCurrent: state.recordedHash === state.currentHash,
      approvalBoundToCurrentHash: state.approvedHash === state.currentHash,
      status:
        state.recordedHash === state.currentHash && state.approvedHash === state.currentHash
          ? "ready"
          : "not-ready"
    };
  }

  function render() {
    summaryEl.textContent = state.exists ? state.summary : "No plan loaded";
    recordedHashEl.textContent = state.recordedHash || "-";
    currentHashEl.textContent = state.currentHash || "-";
    approvedHashEl.textContent = state.approvedHash || "-";
    approvedByEl.textContent = state.approvedBy || "-";
  }

  function renderVerify(report, note) {
    vIntegrityEl.textContent = String(report.integrityMetadataExists);
    vRecordedEl.textContent = String(report.recordedHashMatchesCurrent);
    vApprovedEl.textContent = String(report.approvalBoundToCurrentHash);
    vStatusEl.textContent = report.status;
    vStatusEl.classList.remove("ready", "not-ready");
    vStatusEl.classList.add(report.status);
    verifyNoteEl.textContent = note;
  }

  function log(command, detail) {
    const item = document.createElement("li");
    item.innerHTML = `<code>${command}</code> ${detail}`;
    logEl.appendChild(item);
  }

  function doCreatePlan() {
    state.exists = true;
    state.summary = defaultSummary;
    state.currentHash = computeCurrentHash();
    state.recordedHash = state.currentHash;
    state.approvedHash = null;
    state.approvedBy = null;
    render();
    log("planfile create-plan --from ... --out .plan/demo.json", "created plan artifact");
  }

  function doApprove() {
    if (!state.exists) {
      log("planfile approve-plan .plan/demo.json --by steve", "failed: no plan exists");
      return;
    }
    state.approvedHash = state.currentHash;
    state.approvedBy = "steve";
    render();
    log("planfile approve-plan .plan/demo.json --by steve", "approval hash bound to current plan");
  }

  function doTamper() {
    if (!state.exists) {
      log("node -e '<tamper>'", "no plan to tamper");
      return;
    }
    state.summary = "tampered after approval";
    state.currentHash = computeCurrentHash();
    render();
    log("node -e '<tamper summary>'", "summary modified; current hash changed");
  }

  function doVerify(tag) {
    const report = readVerify();
    const notes = {
      "verify-initial": "Before approval, plan is not ready.",
      "verify-ready": "After approval, verify reports ready.",
      "verify-tampered": "After tampering, verify drops back to not-ready."
    };
    renderVerify(report, notes[tag] || "Verification run complete.");
    log("planfile verify-plan .plan/demo.json", `status=${report.status}`);
  }

  function doApply() {
    const report = readVerify();
    if (report.status !== "ready") {
      log("planfile apply-plan .plan/demo.json --yes", "refused: verification failed (not-ready)");
      return;
    }
    log("planfile apply-plan .plan/demo.json --yes", "apply succeeded");
  }

  function resetAll() {
    state.exists = false;
    state.summary = defaultSummary;
    state.recordedHash = null;
    state.currentHash = null;
    state.approvedHash = null;
    state.approvedBy = null;
    logEl.innerHTML = "";
    render();
    renderVerify(
      {
        integrityMetadataExists: false,
        recordedHashMatchesCurrent: false,
        approvalBoundToCurrentHash: false,
        status: "not-ready"
      },
      "Run verify actions to update this report."
    );
  }

  const handlers = {
    create: doCreatePlan,
    "verify-initial": function () {
      doVerify("verify-initial");
    },
    approve: doApprove,
    "verify-ready": function () {
      doVerify("verify-ready");
    },
    tamper: doTamper,
    "verify-tampered": function () {
      doVerify("verify-tampered");
    },
    apply: doApply,
    reset: resetAll
  };

  document.addEventListener("click", function (event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const action = target.getAttribute("data-action");
    if (!action || !handlers[action]) {
      return;
    }
    handlers[action]();
  });

  resetAll();
})();
