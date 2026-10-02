export async function waitForHomeModel(page) {
  await page.wait(
    "document.getElementById('home-model-picker')?.firstElementChild?.textContent?.trim() && document.getElementById('home-model-picker').firstElementChild.textContent.trim() !== 'Pi model unavailable'",
  );
}

export function reactInputAssignment(id, value) {
  return `const input = document.getElementById(${JSON.stringify(id)}); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; setter.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event("input", { bubbles: true }));`;
}
