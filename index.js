
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

const editor = document.getElementById('editor-textarea');
const highlight = document.querySelector('#editor-highlight code');
const runBtn = document.getElementById('run-btn');
const clearBtn = document.getElementById('clear-btn');
const termOutput = document.getElementById('terminal-output');
const richOutput = document.getElementById('rich-output');
const termInput = document.getElementById('terminal-input');
const promptLabel = document.getElementById('prompt-label');
const statusText = document.getElementById('status-text');
const loadingStatus = document.getElementById('loading-status');

let pyodide = null;
let isWaitingForInput = false;
let inputResolver = null;
const callbacks = new Map();

/**
 * Hyper-Advanced ANSI to HTML Engine
 * Supports: 4-bit, 8-bit (256 color), and 24-bit (TrueColor) RGB
 */
function ansiToHtml(text) {
    if (!text) return "";
    
    let content = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // Use \x1b instead of \033 to avoid strict mode octal errors
    const parts = content.split('\x1b[');
    let result = parts[0];
    let openSpans = 0;

    for (let i = 1; i < parts.length; i++) {
        const part = parts[i];
        const match = part.match(/^([\d;]+)m([\s\S]*)$/);
        if (!match) {
            result += '\x1b[' + part;
            continue;
        }

        const codes = match[1].split(';');
        const remaining = match[2];
        let style = "";

        for (let j = 0; j < codes.length; j++) {
            const code = parseInt(codes[j]);
            if (code === 0) {
                result += '</span>'.repeat(openSpans);
                openSpans = 0;
            } else if (code === 1) { style += "font-weight: bold;"; }
            else if (code === 3) { style += "font-style: italic;"; }
            else if (code === 4) { style += "text-decoration: underline;"; }
            else if (code >= 30 && code <= 37) {
                const colors = ['#000','#c00','#0c0','#c0c','#00c','#c0c','#0cc','#ccc'];
                style += `color: ${colors[code-30]};`;
            }
            else if (code === 38) {
                const type = parseInt(codes[++j]);
                if (type === 5) {
                    const index = parseInt(codes[++j]);
                    style += `color: var(--ansi-color-${index}, rgb(${index},${index},${index}));`;
                } else if (type === 2) {
                    const r = codes[++j], g = codes[++j], b = codes[++j];
                    style += `color: rgb(${r},${g},${b});`;
                }
            }
            else if (code === 48) {
                const type = parseInt(codes[++j]);
                if (type === 2) {
                    const r = codes[++j], g = codes[++j], b = codes[++j];
                    style += `background-color: rgb(${r},${g},${b});`;
                }
            }
        }

        if (style) {
            result += `<span style="${style}">`;
            openSpans++;
        }
        result += remaining;
    }

    return result + '</span>'.repeat(openSpans);
}

function updateHighlight() {
    highlight.textContent = editor.value + (editor.value.endsWith('\n') ? ' ' : '');
    if (window.Prism) Prism.highlightElement(highlight);
}

editor.addEventListener('input', updateHighlight);
editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
        e.preventDefault();
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        editor.value = editor.value.substring(0, start) + "    " + editor.value.substring(end);
        editor.selectionStart = editor.selectionEnd = start + 4;
        updateHighlight();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runCode();
});

function printToTerminal(msg, type = 'stdout') {
    if (!msg) return;
    const isAsciiArt = (msg.match(/[#@%&|\-\+\/\\_]{3,}/g) || []).length > 2;

    if (msg.includes('\r')) {
        const lines = msg.split('\n');
        lines.forEach(line => {
            if (line.includes('\r')) {
                const parts = line.split('\r');
                const lastPart = parts[parts.length - 1];
                if (termOutput.lastChild && termOutput.lastChild.classList.contains('line-part')) {
                    termOutput.lastChild.innerHTML = ansiToHtml(lastPart);
                } else {
                    const div = document.createElement('div');
                    div.className = 'line-part';
                    div.innerHTML = ansiToHtml(lastPart);
                    termOutput.appendChild(div);
                }
            } else {
                appendDiv(line, type, isAsciiArt);
            }
        });
    } else {
        appendDiv(msg, type, isAsciiArt);
    }
    termOutput.scrollTop = termOutput.scrollHeight;
}

function appendDiv(msg, type, isAsciiArt = false) {
    const div = document.createElement('div');
    if (type === 'stderr') div.className = 'text-red-500 font-medium';
    else if (type === 'system') div.className = 'text-blue-500 font-black uppercase text-[9px] tracking-widest mt-2';
    else if (type === 'input') div.className = 'text-green-500 font-bold';
    else div.className = 'text-slate-300';
    
    if (isAsciiArt) div.classList.add('ascii-art');
    
    div.innerHTML = type === 'input' ? `> ${ansiToHtml(msg)}` : ansiToHtml(msg);
    termOutput.appendChild(div);
}

function appendToRichOutput(html, title = "") {
    const container = document.createElement('div');
    container.className = 'bg-slate-900/40 p-4 rounded-xl border border-white/5 backdrop-blur-sm shadow-2xl animate-in fade-in zoom-in-95 duration-500';
    
    if (title) {
        const t = document.createElement('div');
        t.className = 'text-[9px] font-black uppercase tracking-[0.3em] text-slate-600 mb-3 border-b border-white/5 pb-2 flex justify-between items-center';
        t.innerHTML = `<span>${title}</span> <span class="w-1 h-1 rounded-full bg-blue-500"></span>`;
        container.appendChild(t);
    }
    
    const content = document.createElement('div');
    content.innerHTML = html;
    container.appendChild(content);
    
    if (richOutput.children.length === 1 && richOutput.firstChild.classList?.contains('text-center')) {
        richOutput.innerHTML = '';
    }
    
    richOutput.appendChild(container);
    richOutput.scrollTop = richOutput.scrollHeight;
}

window.createWidgetButton = (label, callbackId) => {
    pyodide.runPython(`_trigger_callback("${callbackId}")`);
};

const removeLoadingOverlay = () => {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 500);
    }
};

async function initPython() {
    const safetyTimer = setTimeout(removeLoadingOverlay, 25000);

    try {
        loadingStatus.textContent = "Connecting to WASM Hub...";
        pyodide = await loadPyodide({
            indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/",
            stdout: (text) => printToTerminal(text),
            stderr: (text) => printToTerminal(text, 'stderr'),
        });

        loadingStatus.textContent = "Loading Core Data Tools...";
        await pyodide.loadPackage(["pandas", "matplotlib", "numpy", "micropip", "tqdm"]);

        loadingStatus.textContent = "Configuring Display Bridge...";
        await pyodide.runPythonAsync(`
import sys, io, base64, builtins
import pandas as pd
import matplotlib.pyplot as plt

_py_callbacks = {}

def _trigger_callback(cid):
    if cid in _py_callbacks:
        _py_callbacks[cid]()

def create_button(label, func):
    import uuid
    import js
    cid = str(uuid.uuid4())
    _py_callbacks[cid] = func
    # Corrected Python f-string to use brackets for variable interpolation
    html = f'<button class="py-widget-btn mt-2" onclick="createWidgetButton(\\'{label}\\', \\'{cid}\\')">{label}</button>'
    js.appendToRichOutput(html, "Interactive Widget")

builtins.create_button = create_button

def custom_display(*args, **kwargs):
    import js
    for obj in args:
        title = type(obj).__name__
        if isinstance(obj, pd.DataFrame):
            js.appendToRichOutput(obj.to_html(classes='dataframe', index=False), "DataFrame")
        elif hasattr(obj, 'figure'):
            buf = io.BytesIO()
            obj.figure.savefig(buf, format='png', bbox_inches='tight', transparent=True)
            img_str = base64.b64encode(buf.read()).decode('utf-8')
            js.appendToRichOutput(f'<img src="data:image/png;base64,{img_str}" />', "Static Plot")
        else:
            js.appendToRichOutput(f'<pre style="color: #94a3b8; font-size: 11px; white-space: pre-wrap;">{str(obj)}</pre>', title)

builtins.display = custom_display

def custom_plt_show(*args, **kwargs):
    import js
    buf = io.BytesIO()
    plt.savefig(buf, format='png', bbox_inches='tight', transparent=True, dpi=120)
    img_str = base64.b64encode(buf.read()).decode('utf-8')
    plt.close()
    js.appendToRichOutput(f'<img src="data:image/png;base64,{img_str}" />', "Matplotlib Visualization")

plt.show = custom_plt_show

def custom_input(prompt=""):
    if prompt: print(prompt, end="")
    import js
    return js.__js_request_input(prompt)
builtins.input = custom_input
        `);

        window.__js_request_input = async (prompt) => {
            isWaitingForInput = true;
            promptLabel.classList.add('animate-pulse', 'text-yellow-500');
            statusText.textContent = "Input Required";
            return new Promise(resolve => { inputResolver = resolve; });
        };

        window.appendToRichOutput = appendToRichOutput;

        clearTimeout(safetyTimer);
        removeLoadingOverlay();
        printToTerminal("Kernel initialized. Advanced Terminal v4.1 Ready.", "system");
        updateHighlight();
    } catch (err) {
        console.error("Boot Error:", err);
        clearTimeout(safetyTimer);
        removeLoadingOverlay();
        printToTerminal(`BOOT CRITICAL: ${err.message}`, 'stderr');
        statusText.textContent = "Kernel Offline";
        statusText.classList.add('text-red-500');
    }
}

async function runCode() {
    if (!pyodide) return;
    statusText.textContent = "Executing...";
    runBtn.disabled = true;
    runBtn.classList.add('opacity-50');
    printToTerminal("EXECUTION INITIATED", "system");

    try {
        await pyodide.runPythonAsync(editor.value);
    } catch (err) {
        printToTerminal(err.message, 'stderr');
    } finally {
        statusText.textContent = "Operational";
        runBtn.disabled = false;
        runBtn.classList.remove('opacity-50');
        printToTerminal("EXECUTION COMPLETE", "system");
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
        promptLabel.classList.remove('animate-pulse', 'text-yellow-500');
        statusText.textContent = "Operational";
        inputResolver(val);
        return;
    }

    printToTerminal(cmd, 'input');
    termInput.value = '';

    const installMatch = cmd.match(/^(!?pip3?)\s+install\s+(.+)$/);
    if (installMatch) {
        const pkg = installMatch[2].trim();
        printToTerminal(`PYPI PROTOCOL: INSTALLING ${pkg}...`, 'system');
        try {
            await pyodide.runPythonAsync(`import micropip; await micropip.install("${pkg}")`);
            printToTerminal(`PKG ${pkg} MOUNTED SUCCESSFULLY.`, 'system');
        } catch (e) { printToTerminal(e.message, 'stderr'); }
    } else {
        try {
            const result = await pyodide.runPythonAsync(cmd);
            if (result !== undefined && result !== null) {
                printToTerminal(String(result));
            }
        } catch (err) { printToTerminal(err.message, 'stderr'); }
    }
}

runBtn.addEventListener('click', runCode);
clearBtn.addEventListener('click', () => { 
    termOutput.innerHTML = ''; 
    richOutput.innerHTML = '<div class="text-slate-700 text-[10px] font-medium uppercase text-center mt-10">Awaiting rich signals...</div>';
});
termInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleCommand();
});

initPython();
