(function () {
  const params = new URLSearchParams(location.search);
  const requestId = params.get("requestId") || "";
  const originEl = document.getElementById("request-origin");
  const endpointEl = document.getElementById("endpoint-url");
  const statusEl = document.getElementById("status");
  const approveButton = document.getElementById("approve");
  const rejectButton = document.getElementById("reject");
  let pendingBinding = null;

  approveButton.addEventListener("click", () => {
    finishBinding("APPROVE_FORWARD_ENDPOINT_BINDING");
  });

  rejectButton.addEventListener("click", () => {
    finishBinding("REJECT_FORWARD_ENDPOINT_BINDING");
  });

  initI18n();

  async function initI18n() {
    try {
      await Save2TG.I18n.init();
      Save2TG.I18n.applyDom();
    } catch (_) { /* i18n unavailable */ }
    loadBinding();
  }

  /** Load the pending endpoint binding from the service worker and display it. */
  async function loadBinding() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "GET_PENDING_FORWARD_ENDPOINT_BINDING",
        requestId
      });
      if (!response?.ok) {
        throw new Error(response?.error || Save2TG.I18n.t("confirm_bindingNotFound"));
      }

      const binding = response.result || {};
      pendingBinding = binding;
      originEl.textContent = binding.senderOrigin || Save2TG.I18n.t("confirm_unknownOrigin");
      endpointEl.textContent = binding.endpointUrl || "";
      statusEl.textContent = "";
    } catch (error) {
      setStatus(error.message || String(error));
      approveButton.disabled = true;
    }
  }

  /** Approve or reject the pending endpoint binding request. */
  async function finishBinding(type) {
    approveButton.disabled = true;
    rejectButton.disabled = true;

    try {
      if (type === "APPROVE_FORWARD_ENDPOINT_BINDING") {
        await requestEndpointHostPermission(pendingBinding?.endpointUrl || "");
      }

      const response = await chrome.runtime.sendMessage({ type, requestId });
      if (!response?.ok) {
        throw new Error(response?.error || Save2TG.I18n.t("confirm_operationFailed"));
      }

      window.close();
    } catch (error) {
      setStatus(error.message || String(error));
      approveButton.disabled = false;
      rejectButton.disabled = false;
    }
  }

  /** Update the status text element. */
  function setStatus(message) {
    statusEl.textContent = message;
  }

  /** Request host permission for the endpoint origin via chrome.permissions. */
  async function requestEndpointHostPermission(endpointUrl) {
    const originPattern = getEndpointOriginPattern(endpointUrl);
    if (!originPattern) {
      throw new Error(Save2TG.I18n.t("confirm_invalidEndpointUrl"));
    }

    const hasPermission = await chrome.permissions.contains({ origins: [originPattern] });
    if (hasPermission) {
      return;
    }

    const granted = await chrome.permissions.request({ origins: [originPattern] });
    if (!granted) {
      throw new Error(Save2TG.I18n.t("confirm_permissionRequired"));
    }
  }

  /** Convert an endpoint URL to a match pattern for chrome.permissions. */
  function getEndpointOriginPattern(endpointUrl) {
    try {
      const url = new URL(endpointUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return "";
      }

      const hostname = url.hostname.includes(":") ? `[${url.hostname}]` : url.hostname;
      return `${url.protocol}//${hostname}/*`;
    } catch (_) {
      return "";
    }
  }
})();
