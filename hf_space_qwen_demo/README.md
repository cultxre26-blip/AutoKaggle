---
title: Qwen3.5 9B Defiant Fable Dark Roast Demo
emoji: 🔥
colorFrom: red
colorTo: purple
sdk: gradio
sdk_version: 4.44.0
app_file: app.py
pinned: false
license: apache-2.0
---

# Qwen3.5-9B The Defiant Fable — DARK ROAST (Uncensored/Heretic NEO-IMATRIX-MAX) Demo

Interactive chat demo for
[DavidAU/Qwen3.5-9B-The-Defiant-Fable-DARK-ROAST-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP](https://huggingface.co/DavidAU/Qwen3.5-9B-The-Defiant-Fable-DARK-ROAST-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP).

This Space runs a quantized **GGUF** build of the model locally with
[`llama-cpp-python`](https://github.com/abetlen/llama-cpp-python) — no external
inference API is used. On startup it downloads a single GGUF quant file from
the model repo (`GGUF_FILENAME` env var, defaults to a mid-size `Q4_K_M`
quant) via `huggingface_hub.hf_hub_download`, loads it, and exposes a simple
Gradio chat UI.

## Notes

- This is an uncensored/"heretic" community fine-tune. It is provided as-is by
  its author; use responsibly and at your own discretion.
- CPU inference of a 9B model is slow. For a usable experience, run this
  Space on a GPU-enabled Space hardware tier (`llama-cpp-python` is built
  with `GGML_CUDA` support here) or pick a smaller/more aggressive quant via
  the `GGUF_FILENAME` variable.
- Set the `GGUF_FILENAME` repository secret/variable to pick a specific quant
  file name from the model repo's file list if the default is unavailable.

## Local development

```bash
pip install -r requirements.txt
python app.py
```
