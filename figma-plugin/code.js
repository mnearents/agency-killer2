"use strict";
// Figma Plugin Code - runs in the Figma sandbox
figma.showUI(__html__, { width: 400, height: 500 });
// Load saved settings from clientStorage and send to UI
async function loadSettings() {
    const apiUrl = await figma.clientStorage.getAsync('apiUrl');
    const apiKey = await figma.clientStorage.getAsync('apiKey');
    figma.ui.postMessage({ type: 'load-settings', apiUrl, apiKey });
}
loadSettings();
// Listen for messages from the UI
figma.ui.onmessage = async (msg) => {
    if (msg.type === 'save-settings') {
        if (msg.apiUrl)
            await figma.clientStorage.setAsync('apiUrl', msg.apiUrl);
        if (msg.apiKey)
            await figma.clientStorage.setAsync('apiKey', msg.apiKey);
        return;
    }
    if (msg.type === 'insert-text') {
        const { text } = msg;
        // Create a text node with the generated text
        const textNode = figma.createText();
        // Load default font
        await figma.loadFontAsync({ family: "Inter", style: "Regular" });
        textNode.characters = text;
        // Position the text at the center of the viewport
        textNode.x = figma.viewport.center.x;
        textNode.y = figma.viewport.center.y;
        // Select the newly created text
        figma.currentPage.appendChild(textNode);
        figma.currentPage.selection = [textNode];
        figma.viewport.scrollAndZoomIntoView([textNode]);
        figma.ui.postMessage({ type: 'text-inserted' });
    }
    if (msg.type === 'close') {
        figma.closePlugin();
    }
    if (msg.type === 'notify') {
        figma.notify(msg.message);
    }
};
