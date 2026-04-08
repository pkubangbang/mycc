# Ollama Vision Capabilities Guide

## Overview

Ollama's **Vision** feature enables multimodal models — models that can process both text and images — to describe, classify, and answer questions about visual content. This is powered by vision-capable models such as `gemma3`, `llava`, and `gemma4:31b-cloud` that accept image inputs alongside text prompts.

---

## How It Works

Vision models extend the standard chat interface with an `images` field. When you send a message containing both a text prompt and image data, the model processes both modalities together to generate a response that references the visual content.

The image data is transmitted as a **base64-encoded string** in the `images` array of the user message. The Ollama SDKs (Python, JavaScript) accept file paths, URLs, or raw bytes and handle encoding automatically. The REST API expects base64-encoded strings directly.

---

## Quick Start

The simplest way to use vision is via the CLI:

```bash
ollama run gemma3 ./image.png "What is in this image?"
```

This sends the image file along with the prompt to the `gemma3` model and prints the model's description of the image.

---

## API Usage

### cURL (REST API)

The REST API requires you to manually base64-encode the image and include it in the `images` array:

```bash
# 1. Download a sample image
curl -L -o test.jpg "https://upload.wikimedia.org/wikipedia/commons/3/3a/Cat03.jpg"

# 2. Encode the image
IMG=$(base64 < test.jpg | tr -d '\n')

# 3. Send it to Ollama
curl -X POST http://localhost:11434/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemma3",
    "messages": [{
      "role": "user",
      "content": "What is in this image?",
      "images": ["'"$IMG"'"]
    }],
    "stream": false
  }'
```

**Key points:**
- The `images` field is an array of base64-encoded strings (no `data:` prefix needed).
- The model name must be a vision-capable model.
- Set `stream: false` for a single complete response.

### Python SDK

The Python SDK simplifies image handling by accepting file paths directly:

```python
from ollama import chat

path = input('Please enter the path to the image: ')

response = chat(
  model='gemma3',
  messages=[
    {
      'role': 'user',
      'content': 'What is in this image? Be concise.',
      'images': [path],
    }
  ],
)

print(response.message.content)
```

The SDK also supports passing base64-encoded strings or raw bytes directly:

```python
import base64
from pathlib import Path
from ollama import chat

# Base64 encoded
img = base64.b64encode(Path(path).read_bytes()).decode()
response = chat(model='gemma3', messages=[{
  'role': 'user',
  'content': 'Describe this image',
  'images': [img],
}])

# Raw bytes
img = Path(path).read_bytes()
response = chat(model='gemma3', messages=[{
  'role': 'user',
  'content': 'Describe this image',
  'images': [img],
}])
```

### JavaScript / TypeScript SDK

```javascript
import ollama from 'ollama'

const imagePath = '/absolute/path/to/image.jpg'
const response = await ollama.chat({
  model: 'gemma3',
  messages: [
    { role: 'user', content: 'What is in this image?', images: [imagePath] }
  ],
  stream: false,
})

console.log(response.message.content)
```

The JavaScript SDK accepts file paths as strings and handles base64 encoding internally.

---

## Available Vision Models

| Model | Description |
|-------|-------------|
| `gemma3` | Google's Gemma 3 with vision capabilities (various sizes) |
| `gemma4:31b-cloud` | Gemma 4 31B parameter cloud-hosted vision model |
| `llava` | Large Language and Vision Assistant |
| `minicpm-v` | Efficient vision-language model |

To check available models on your system:

```bash
ollama list
```

To pull a vision model:

```bash
ollama pull gemma3
```

---

## Practical Use Cases

### Screen Reading / Accessibility
Capture a screenshot and ask the model to describe the on-screen content — useful for accessibility, debugging UI issues, or automated testing.

### Document OCR
Feed an image of a document to extract and structure the text content.

### Image Classification
Ask the model to categorize or tag images based on their visual content.

### Visual Q&A
Ask specific questions about what's visible in an image (e.g., "What error message is displayed?" or "How many items are in this list?").

---

## Tips for Best Results

1. **Resize large images**: Sending very high-resolution images (e.g., 4K screenshots) increases API payload size and processing time. Resize to ~1280px wide for optimal performance.
2. **Be specific with prompts**: Instead of "What's in this image?", try "Read the error message shown in the terminal window" for more targeted responses.
3. **Use region cropping**: If you only need part of the screen, crop the image before sending to reduce noise and improve accuracy.
4. **Model selection matters**: Larger models (e.g., `gemma4:31b-cloud`) generally produce more accurate and detailed descriptions but take longer to respond.

---

## Source

This guide is based on the official Ollama Vision documentation: [https://docs.ollama.com/capabilities/vision](https://docs.ollama.com/capabilities/vision)