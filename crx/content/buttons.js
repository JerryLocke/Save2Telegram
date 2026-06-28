/** Find all mount points and inject forward buttons where needed. */
function renderButtons() {
  const existingWrappers = Array.from(document.querySelectorAll(`.${WRAPPER_CLASS},#${WRAPPER_ID}`));

  const mounts = findButtonMounts();
  if (!mounts.length) {
    existingWrappers.forEach((wrapper) => wrapper.remove());
    return false;
  }

  const mountedParents = new Set(mounts.map((mount) => mount.parent));

  existingWrappers.forEach((wrapper) => {
    if (!mountedParents.has(wrapper.parentElement)) {
      wrapper.remove();
    }
  });

  mounts.forEach(ensureButtonAtMount);
  return true;
}

/** Ensure a forward button exists at a given mount point. Returns the button. */
function ensureButtonAtMount(mount) {
  const existingWrapper = Array.from(mount.parent.querySelectorAll(`.${WRAPPER_CLASS},#${WRAPPER_ID}`))
    .find((wrapper) => wrapper.dataset.tfForwardAction === "true");

  if (existingWrapper) {
    syncWrapperWithMount(existingWrapper, mount);
    const existingButton = existingWrapper.querySelector(`.${BUTTON_CLASS},#${BUTTON_ID}`);
    if (existingButton) {
      syncButtonSurface(existingButton, mount);
      bindButtonInteractions(existingWrapper, existingButton);
    }

    if (!isMountedAtTarget(existingWrapper, mount)) {
      insertAfter(mount.parent, existingWrapper, mount.after);
    }

    return;
  }

  const wrapper = document.createElement("div");
  syncWrapperWithMount(wrapper, mount);

  const button = document.createElement("button");
  button.type = "button";
  button.className = BUTTON_CLASS;
  setButtonState(button, false, LABEL_READY());
  syncButtonSurface(button, mount);
  bindButtonInteractions(wrapper, button);
  wrapper.append(button);
  insertAfter(mount.parent, wrapper, mount.after);
}
