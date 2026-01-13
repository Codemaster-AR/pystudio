
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// DOM References
const editor = document.getElementById('editor-textarea');
const highlight = document.querySelector('#editor-highlight code');
const highlightPre = document.getElementById('editor-highlight');
const runBtn = document.getElementById('run-btn');
const termOutput = document.getElementById('terminal-output');
const richOutput = document.getElementById('rich-output');
const termInput = document.getElementById('terminal-input');
const statusText = document.getElementById('status-text');
const lineCol = document.getElementById('line-col');
const clearRichBtn = document.getElementById('clear-rich');
const loadingStatus = document.getElementById('loading-status');

let pyodide = null;
let isWaitingForInput = false;
let inputResolver = null;

/**
 * Enhanced ANSI to HTML with VS Code theme support
 */
function ansiToHtml(text) {
    if (!text) return "";
    let content = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const parts = content.split('\x1b[');
    let result = parts[0];
    let openSpans = 0;
    for (let i = 1; i < parts.length; i++) {
        const part = parts[i];
        const match = part.match(/^([\d;]+)m([\s\S]*)$/);
        if (!match) { result += '\x1b[' + part; continue; }
        const codes = match[1].split(';');
        let style = "";
        for (let j = 0; j < codes.length; j++) {
            const code = parseInt(codes[j]);
            if (code === 0) { result += '</span>'.repeat(openSpans); openSpans = 0; }
            else if (code === 1) style += "font-weight: bold;";
            else if (code >= 31 && code <= 37) {
                const colors = ['', '#f85149', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#ffffff'];
                style += `color: ${colors[code-31]};`;
            }
        }
        if (style) { result += `<span style="${style}">`; openSpans++; }
        result += match[2];
    }
    return result + '</span>'.repeat(openSpans);
}

// Pixel-Perfect Editor Sync
function updateHighlight() {
    highlight.textContent = editor.value + (editor.value.endsWith('\n') ? ' ' : '');
    if (window.Prism) Prism.highlightElement(highlight);
    highlightPre.scrollTop = editor.scrollTop;
    highlightPre.scrollLeft = editor.scrollLeft;
    
    // Update Line/Col
    const textBeforeCaret = editor.value.substring(0, editor.selectionStart);
    const lines = textBeforeCaret.split('\n');
    lineCol.textContent = `Ln ${lines.length}, Col ${lines[lines.length-1].length + 1}`;
}

editor.addEventListener('input', updateHighlight);
editor.addEventListener('scroll', updateHighlight);
editor.addEventListener('click', updateHighlight);
editor.addEventListener('keyup', updateHighlight);

editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
        e.preventDefault();
        const start = editor.selectionStart;
        editor.value = editor.value.substring(0, start) + "    " + editor.value.substring(editor.selectionEnd);
        editor.selectionStart = editor.selectionEnd = start + 4;
        updateHighlight();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runCode();
});

function printToTerminal(msg, type = 'stdout') {
    if (!msg) return;
    const div = document.createElement('div');
    if (type === 'stderr') div.className = 'text-red-400 font-medium';
    else if (type === 'system') div.className = 'text-blue-500 font-bold text-[10px] uppercase mt-2';
    else if (type === 'input') div.className = 'text-green-500 font-bold';
    else div.className = 'text-slate-300';
    
    div.innerHTML = type === 'input' ? `> ${ansiToHtml(msg)}` : ansiToHtml(msg);
    termOutput.appendChild(div);
    termOutput.scrollTop = termOutput.scrollHeight;
}

function appendToRichOutput(html, title = "") {
    const container = document.createElement('div');
    container.className = 'bg-[#161b22] p-4 rounded-lg border border-[#30363d] animate-in fade-in duration-300';
    if (title) {
        container.innerHTML = `<div class="text-[9px] font-bold text-slate-500 uppercase mb-2 border-b border-[#30363d] pb-1">${title}</div>`;
    }
    const content = document.createElement('div');
    content.className = 'overflow-x-auto';
    content.innerHTML = html;
    container.appendChild(content);
    
    if (richOutput.innerText.includes("Visual objects will appear here")) richOutput.innerHTML = '';
    richOutput.appendChild(container);
    richOutput.scrollTop = richOutput.scrollHeight;
}

window.createWidgetButton = (label, callbackId) => {
    pyodide.runPython(`_trigger_callback("${callbackId}")`);
};

async function initPython() {
    try {
        loadingStatus.textContent = "Booting Pyodide Runtime...";
        pyodide = await loadPyodide({
            indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/",
            stdout: (text) => printToTerminal(text),
            stderr: (text) => printToTerminal(text, 'stderr'),
        });

        loadingStatus.textContent = "Injecting Scientific Stack...";
        await pyodide.loadPackage(["pandas", "numpy", "matplotlib", "micropip"]);

        loadingStatus.textContent = "Applying OS-Level Patches...";
        await pyodide.runPythonAsync(`
import sys, io, base64, builtins, os, time
import pandas as pd
import matplotlib.pyplot as plt

# SUBPROCESS PATCH: Prevent crash on playsound3 or similar libs
class MockSubprocess:
    def run(self, args, *nargs, **kwargs):
        print(f"\\n\\x1b[33m[WASM WARNING]\\x1b[0m Subprocess calls are disabled in browser sandbox: {' '.join(args)}")
        return type('Result', (), {'returncode': 0, 'stdout': b'', 'stderr': b''})

sys.modules['subprocess'] = MockSubprocess()

# Display Bridge
def custom_display(*args):
    import js
    for obj in args:
        if isinstance(obj, pd.DataFrame):
            js.appendToRichOutput(obj.to_html(classes='dataframe'), "DataFrame")
        else:
            js.appendToRichOutput(f'<pre class="text-xs text-slate-400">{str(obj)}</pre>', type(obj).__name__)
builtins.display = custom_display

_py_callbacks = {}
def _trigger_callback(cid):
    if cid in _py_callbacks: _py_callbacks[cid]()

def create_button(label, func):
    import uuid, js
    cid = str(uuid.uuid4())
    _py_callbacks[cid] = func
    js.appendToRichOutput(f'<button class="px-3 py-1 bg-blue-600 rounded text-xs text-white" onclick="createWidgetButton(\\'{label}\\', \\'{cid}\\')">{label}</button>', "Widget")
builtins.create_button = create_button

def custom_input(prompt=""):
    if prompt: print(prompt, end="")
    import js
    return js.__js_request_input(prompt)
builtins.input = custom_input
        `);

        window.__js_request_input = async () => {
            isWaitingForInput = true;
            statusText.textContent = "Awaiting Input";
            return new Promise(resolve => { inputResolver = resolve; });
        };

        window.appendToRichOutput = appendToRichOutput;

        document.getElementById('loading-overlay').style.opacity = '0';
        setTimeout(() => document.getElementById('loading-overlay').remove(), 700);
        statusText.textContent = "Ready";
        updateHighlight();
    } catch (err) {
        console.error(err);
        loadingStatus.textContent = "Boot Failed: " + err.message;
    }
}

async function runCode() {
    if (!pyodide) return;
    statusText.textContent = "Executing...";
    printToTerminal("PROCESS START", "system");
    try {
        await pyodide.runPythonAsync(editor.value);
    } catch (err) {
        printToTerminal(err.message, 'stderr');
    } finally {
        statusText.textContent = "Ready";
        printToTerminal("PROCESS END", "system");
    }
}

async function handleCommand() {
    const cmd = termInput.value.trim();
    if (!cmd && !isWaitingForInput) return;

    if (isWaitingForInput) {
        const val = termInput.value;
        printToTerminal(val, 'input');
        termInput.value = '';
        isWaitingForInput = false;
        statusText.textContent = "Ready";
        inputResolver(val);
        return;
    }

    printToTerminal(cmd, 'input');
    termInput.value = '';

    if (cmd.startsWith('pip install ')) {
        const pkg = cmd.replace('pip install ', '');
        printToTerminal(`FETCHING PKG ${pkg}...`, 'system');
        try {
            await pyodide.runPythonAsync(`import micropip; await micropip.install("${pkg}")`);
            printToTerminal(`PKG ${pkg} LOADED.`, 'system');
        } catch (e) { printToTerminal(e.message, 'stderr'); }
    } else {
        try {
            const result = await pyodide.runPythonAsync(cmd);
            if (result !== undefined) printToTerminal(String(result));
        } catch (err) { printToTerminal(err.message, 'stderr'); }
    }
}

runBtn.addEventListener('click', runCode);
termInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleCommand(); });
clearRichBtn.addEventListener('click', () => richOutput.innerHTML = '');

initPython();
