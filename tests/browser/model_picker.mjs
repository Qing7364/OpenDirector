/** Shared model picker driver for node composers. */
export async function chooseGenerationModel(page, choice) {
  await page.getByRole("combobox", { name: "生成模型", exact: true }).click();
  const list = page.getByRole("listbox", { name: "生成模型", exact: true });
  if (typeof choice === "string")
    await list.locator(`[data-option-id="${choice}"]`).click();
  else await list.getByRole("option", { name: choice.label, exact: true }).click();
}
