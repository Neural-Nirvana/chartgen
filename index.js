import * as webllm from "https://esm.run/@mlc-ai/web-llm";

/*************** IndexedDB logic ***************/
const DB_NAME = 'WebLLMStorage';
const STORE_NAME = 'ModelStore';

async function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onerror = () => reject("Error opening database");
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      db.createObjectStore(STORE_NAME);
    };
  });
}

async function storeModelChunk(modelId, chunkId, chunkData) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(chunkData, `${modelId}_${chunkId}`);
    request.onerror = () => reject("Error storing model chunk");
    request.onsuccess = () => resolve();
  });
}

async function retrieveModelChunk(modelId, chunkId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(`${modelId}_${chunkId}`);
    request.onerror = () => reject("Error retrieving model chunk");
    request.onsuccess = () => resolve(request.result);
  });
}

/*************** WebLLM logic ***************/
const messages = [{
  content: "You are a helpful AI agent helping users generate mermaid code. You only reply in mermaid language.",
  role: "system",
}];

const availableModels = webllm.prebuiltAppConfig.model_list.map(
  (m) => m.model_id,
);
let selectedModel = "Llama-3-8B-Instruct-q4f32_1-MLC-1k";

// Create engine instance
const engine = new webllm.MLCEngine();

// Custom progress callback
async function customProgressCallback(report) {
  console.log("Progress:", report);
  const downloadStatus = document.getElementById("download-status");
  if (downloadStatus) downloadStatus.textContent = report.text;

  // If we're downloading, store the chunk
  if (report.type === 'download' && report.loaded < report.total) {
    const chunkId = report.loaded;
    const chunkData = new Uint8Array(report.data);
    await storeModelChunk(selectedModel, chunkId, chunkData);
  }
}

engine.setInitProgressCallback(customProgressCallback);

async function initializeWebLLMEngine() {
  const downloadStatus = document.getElementById("download-status");
  const modelSelection = document.getElementById("model-selection");
  const sendButton = document.getElementById("send");

  if (downloadStatus) downloadStatus.classList.remove("hidden");
  if (modelSelection) selectedModel = modelSelection.value;
  
  const config = {
    temperature: 1.0,
    top_p: 1,
  };
  
  // Custom loader function
  const customLoader = async (modelConfig, loadType) => {
    const chunkId = loadType.chunk_id;
    const storedChunk = await retrieveModelChunk(selectedModel, chunkId);
    if (storedChunk) {
      console.log(`Loading chunk ${chunkId} from IndexedDB`);
      return storedChunk;
    }
    console.log(`Chunk ${chunkId} not found in IndexedDB, will download`);
    return null;  // Return null to indicate the chunk should be downloaded
  };

  try {
    await engine.reload(selectedModel, config, customLoader);
    if (sendButton) sendButton.disabled = false;
  } catch (error) {
    console.error("Error initializing WebLLM engine:", error);
    if (downloadStatus) downloadStatus.textContent = "Error initializing model. Please try again.";
  }
}

async function streamingGenerating(messages, onUpdate, onFinish, onError) {
  try {
    let curMessage = "";
    const completion = await engine.chat.completions.create({
      stream: true,
      messages,
    });
    for await (const chunk of completion) {
      const curDelta = chunk.choices[0].delta.content;
      if (curDelta) {
        curMessage += curDelta;
        onUpdate(curMessage);
      }
    }
    const finalMessage = await engine.getMessage();
    onFinish(finalMessage);
  } catch (err) {
    onError(err);
  }
}

/*************** UI logic ***************/
function onMessageSend() {
  console.log("onMessageSend function called");
  const userInput = document.getElementById("user-input");
  const sendButton = document.getElementById("send");
  const llmResponseBox = document.getElementById("llm-response");
  const chatBox = document.getElementById("chat-box");

  if (!userInput || !sendButton || !llmResponseBox || !chatBox) {
    console.error("Required elements not found:", { userInput, sendButton, llmResponseBox, chatBox });
    alert("Some UI elements are missing. Please check the console for more information.");
    return;
  }

  const input = userInput.value.trim();
  if (input.length === 0) {
    console.log("Empty input, not sending message");
    return;
  }

  console.log("Sending message:", input);
  
  sendButton.disabled = true;

  const message = { content: input, role: "user" };
  messages.push(message);
  appendMessage(message);

  userInput.value = "";
  userInput.setAttribute("placeholder", "Generating...");

  const aiMessage = { content: "typing...", role: "assistant" };
  appendMessage(aiMessage);

  llmResponseBox.textContent = "";

  const onUpdate = (content) => {
    updateLastMessage(content);
    updateLLMResponse(content);
  };

  const onFinishGenerating = (finalMessage) => {
    updateLastMessage(finalMessage);
    updateLLMResponse(finalMessage);
    sendButton.disabled = false;
    engine.runtimeStatsText().then(statsText => {
      const chatStats = document.getElementById('chat-stats');
      if (chatStats) {
        chatStats.classList.remove('hidden');
        chatStats.textContent = statsText;
      }
    });
  };

  streamingGenerating(
    messages,
    onUpdate,
    onFinishGenerating,
    (error) => {
      console.error("Error in message generation:", error);
      const errorMessage = "An error occurred while generating the response.";
      updateLastMessage(errorMessage);
      updateLLMResponse(errorMessage);
      sendButton.disabled = false;
    }
  );
}

function appendMessage(message) {
  const chatBox = document.getElementById("chat-box");
  if (!chatBox) return;

  const container = document.createElement("div");
  container.classList.add("message-container");
  const newMessage = document.createElement("div");
  newMessage.classList.add("message");
  newMessage.textContent = message.content;

  if (message.role === "user") {
    container.classList.add("user");
  } else {
    container.classList.add("assistant");
  }

  container.appendChild(newMessage);
  chatBox.appendChild(container);
  chatBox.scrollTop = chatBox.scrollHeight; // Scroll to the latest message
}

function updateLastMessage(content) {
  const chatBox = document.getElementById("chat-box");
  if (!chatBox) return;

  const messageDoms = chatBox.querySelectorAll(".message");
  const lastMessageDom = messageDoms[messageDoms.length - 1];
  if (lastMessageDom) lastMessageDom.textContent = content;
}

function updateLLMResponse(content) {
  const llmResponseBox = document.getElementById("llm-response");
  if (llmResponseBox) {
    llmResponseBox.textContent = content;
    llmResponseBox.scrollTop = llmResponseBox.scrollHeight; // Scroll to the bottom of the response
  }
}

/*************** Initialization and Event Listeners ***************/
function initializeUI() {
  console.log("Initializing UI");
  const modelSelection = document.getElementById("model-selection");
  const downloadButton = document.getElementById("download");
  const sendButton = document.getElementById("send");
  const userInput = document.getElementById("user-input");
  const llmResponseBox = document.getElementById("llm-response");
  const chatBox = document.getElementById("chat-box");

  if (!modelSelection || !downloadButton || !sendButton || !userInput || !llmResponseBox || !chatBox) {
    console.error("Some required elements are missing:", { 
      modelSelection, downloadButton, sendButton, userInput, llmResponseBox, chatBox 
    });
    alert("Some UI elements are missing. Please check the console for more information.");
    return;
  }

  availableModels.forEach((modelId) => {
    const option = document.createElement("option");
    option.value = modelId;
    option.textContent = modelId;
    modelSelection.appendChild(option);
  });
  modelSelection.value = selectedModel;

  downloadButton.addEventListener("click", () => {
    console.log("Download button clicked");
    initializeWebLLMEngine().then(() => {
      sendButton.disabled = false;
      console.log("Send button enabled after engine initialization");
    }).catch(error => {
      console.error("Error initializing WebLLM engine:", error);
      const downloadStatus = document.getElementById("download-status");
      if (downloadStatus) downloadStatus.textContent = "Error initializing model. Please try again.";
    });
  });

  sendButton.addEventListener("click", () => {
    console.log("Send button clicked");
    onMessageSend();
  });

  userInput.addEventListener("keypress", function(event) {
    if (event.key === "Enter") {
      console.log("Enter key pressed in input");
      event.preventDefault();
      onMessageSend();
    }
  });

  console.log("UI initialization completed");
}

// Wait for the DOM to be fully loaded before initializing
document.addEventListener("DOMContentLoaded", () => {
  console.log("DOM fully loaded");
  initializeUI();
});

// Global error handler
window.addEventListener('error', function(event) {
  console.error('Global error caught:', event.error);
});