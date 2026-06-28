// ==================== UI Helpers ====================

function stripImageSizeParams(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("name", "orig");
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Normalize a tweet URL to its canonical form, stripping query params. */
function normalizeTweetUrl(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/([^/]+)\/status\/(\d+)/);
    if (!match) {
      return url;
    }

    return `https://x.com/${match[1]}/status/${match[2]}`;
  } catch {
    return url;
  }
}

/** Update a forward button's disabled state and label. */
function setButtonState(button, disabled, label) {
  if (!button) {
    return;
  }

  button.disabled = disabled;
  button.innerHTML = label === LABEL_SENT() ? ICON_SENT : ICON_READY;
  // X's native tooltip is internal to its React tree; browser-native title avoids brittle imitation.
  button.title = label;
  button.setAttribute("aria-label", label);
}

/** Display a toast notification on the page. */
function showToast(message, isError = false) {
  document.getElementById(TOAST_ID)?.remove();

  const toast = document.createElement("div");
  toast.id = TOAST_ID;
  toast.className = isError ? "tf-error" : "";
  toast.textContent = message;
  document.body.append(toast);

  setTimeout(() => toast.remove(), 3200);
}
