function getBulkSelectionState(items, options = {}) {
  const sourceItems = Array.isArray(items) ? items : [];
  const isControllable = typeof options.isControllable === "function"
    ? options.isControllable
    : () => true;
  const isEnabled = typeof options.isEnabled === "function"
    ? options.isEnabled
    : (item) => item?.enabled !== false;
  const controllableItems = sourceItems.filter((item, index) => isControllable(item, index));
  const enabledCount = controllableItems.filter((item, index) => isEnabled(item, index)).length;
  const checked = controllableItems.length > 0 && enabledCount === controllableItems.length;
  const indeterminate = enabledCount > 0 && enabledCount < controllableItems.length;

  return {
    checked,
    indeterminate,
    disabled: controllableItems.length === 0,
    nextEnabled: !checked && !indeterminate,
    controllableItems
  };
}

module.exports = {
  getBulkSelectionState
};
