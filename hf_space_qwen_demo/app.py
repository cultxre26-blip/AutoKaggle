"""Gradio chat demo for DavidAU/Qwen3.5-9B-The-Defiant-Fable-DARK-ROAST-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP.

Downloads a single GGUF quant from the model repo and serves it locally with
llama-cpp-python, no external inference API required.
"""

import os

import gradio as gr
from huggingface_hub import hf_hub_download
from llama_cpp import Llama

MODEL_REPO = "DavidAU/Qwen3.5-9B-The-Defiant-Fable-DARK-ROAST-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP"
GGUF_FILENAME = os.environ.get(
    "GGUF_FILENAME",
    "Qwen3.5-9B-The-Defiant-Fable-DARK-ROAST-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP-Q4_K_M.gguf",
)
N_CTX = int(os.environ.get("N_CTX", "8192"))
N_GPU_LAYERS = int(os.environ.get("N_GPU_LAYERS", "-1"))

SYSTEM_PROMPT = (
    "You are a helpful, creative writing assistant. This is a community "
    "fine-tune demo; content may be unfiltered compared to typical assistants."
)

_llm = None


def get_llm() -> Llama:
    global _llm
    if _llm is None:
        model_path = hf_hub_download(repo_id=MODEL_REPO, filename=GGUF_FILENAME)
        _llm = Llama(
            model_path=model_path,
            n_ctx=N_CTX,
            n_gpu_layers=N_GPU_LAYERS,
            verbose=False,
        )
    return _llm


def respond(message, history, system_prompt, temperature, top_p, max_tokens):
    llm = get_llm()

    messages = [{"role": "system", "content": system_prompt}]
    for user_msg, assistant_msg in history:
        if user_msg:
            messages.append({"role": "user", "content": user_msg})
        if assistant_msg:
            messages.append({"role": "assistant", "content": assistant_msg})
    messages.append({"role": "user", "content": message})

    stream = llm.create_chat_completion(
        messages=messages,
        temperature=temperature,
        top_p=top_p,
        max_tokens=max_tokens,
        stream=True,
    )

    partial = ""
    for chunk in stream:
        delta = chunk["choices"][0]["delta"].get("content", "")
        if delta:
            partial += delta
            yield partial


with gr.Blocks(title="Qwen3.5-9B Defiant Fable DARK-ROAST Demo") as demo:
    gr.Markdown(
        f"# Qwen3.5-9B The Defiant Fable — DARK ROAST\n"
        f"Local GGUF inference of [`{MODEL_REPO}`]"
        f"(https://huggingface.co/{MODEL_REPO}) via `llama-cpp-python`. "
        f"Quant: `{GGUF_FILENAME}`."
    )

    with gr.Accordion("Generation settings", open=False):
        system_prompt = gr.Textbox(label="System prompt", value=SYSTEM_PROMPT, lines=3)
        temperature = gr.Slider(0.0, 2.0, value=0.8, step=0.05, label="Temperature")
        top_p = gr.Slider(0.0, 1.0, value=0.95, step=0.01, label="Top-p")
        max_tokens = gr.Slider(64, 4096, value=512, step=64, label="Max new tokens")

    gr.ChatInterface(
        fn=respond,
        additional_inputs=[system_prompt, temperature, top_p, max_tokens],
        title=None,
    )

if __name__ == "__main__":
    demo.queue().launch()
