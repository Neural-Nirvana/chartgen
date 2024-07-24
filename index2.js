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
  document.getElementById("download-status").textContent = report.text;

  // If we're downloading, store the chunk
  if (report.type === 'download' && report.loaded < report.total) {
    const chunkId = report.loaded;
    const chunkData = new Uint8Array(report.data);
    await storeModelChunk(selectedModel, chunkId, chunkData);
  }
}

engine.setInitProgressCallback(customProgressCallback);

async function initializeWebLLMEngine() {
  document.getElementById("download-status").classList.remove("hidden");
  selectedModel = document.getElementById("model-selection").value;
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
    document.getElementById("send").disabled = false;
  } catch (error) {
    console.error("Error initializing WebLLM engine:", error);
    document.getElementById("download-status").textContent = "Error initializing model. Please try again.";
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
      }
      onUpdate(curMessage);
    }
    const finalMessage = await engine.getMessage();
    onFinish(finalMessage);
  } catch (err) {
    onError(err);
  }
}

/*************** UI logic ***************/
function onMessageSend() {
  const input = document.getElementById("user-input").value.trim();
  const message = {
    content: input,
    role: "user",
  };
  if (input.length === 0) {
    return;
  }
  document.getElementById("send").disabled = true;

  messages.push(message);
  appendMessage(message);

  document.getElementById("user-input").value = "";
  document.getElementById("user-input").setAttribute("placeholder", "Generating...");

  const aiMessage = {
    content: "typing...",
    role: "assistant",
  };
  appendMessage(aiMessage);

  // document.getElementById("llm-response").textContent = "";

  const onFinishGenerating = (finalMessage) => {
    updateLastMessage(finalMessage);
    updateLLMResponse(finalMessage);
    document.getElementById("send").disabled = false;
    engine.runtimeStatsText().then(statsText => {
      document.getElementById('chat-stats').classList.remove('hidden');
      document.getElementById('chat-stats').textContent = statsText;
    })
  };

  streamingGenerating(
    messages,
    updateLastMessage,
    onFinishGenerating,
    console.error,
  );
}


function appendMessage(message) {
  const chatBox = document.getElementById("chat-box");
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
  const messageDoms = document.getElementById("chat-box").querySelectorAll(".message");
  const lastMessageDom = messageDoms[messageDoms.length - 1];
  lastMessageDom.textContent = content;
}

function updateLLMResponse(content) {
  const llmResponseBox = document.getElementById("llm-response");
  llmResponseBox.textContent = content;
  llmResponseBox.scrollTop = llmResponseBox.scrollHeight; // Scroll to the bottom of the response
}

/*************** UI binding ***************/
availableModels.forEach((modelId) => {
  const option = document.createElement("option");
  option.value = modelId;
  option.textContent = modelId;
  document.getElementById("model-selection").appendChild(option);
});
document.getElementById("model-selection").value = selectedModel;
document.getElementById("download").addEventListener("click", function() {
  initializeWebLLMEngine().then(() => {
    document.getElementById("send").disabled = false;
  });
});
document.getElementById("send").addEventListener("click", function() {
  onMessageSend();
});

// Add event listener for pressing Enter in the input field
document.getElementById("user-input").addEventListener("keypress", function(event) {
  if (event.key === "Enter") {
    event.preventDefault();
    onMessageSend();
  }
});