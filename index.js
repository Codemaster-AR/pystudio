
import { GoogleGenAI } from "@google/genai";

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// DOM Elements
const editor = document.getElementById('editor-textarea');
const highlight = document.querySelector('#editor-highlight code');
const runBtn = document.getElementById('run-btn');
const clearBtn = document.getElementById('clear-btn');
const termOutput = document.getElementById('terminal-output');
const termInput = document.getElementById('terminal-input');
const promptLabel = document.getElementById('prompt-label');
const statusText = document.getElementById('status-text');
const aiResponse = document.getElementById('ai-response');

let pyodide = null;
let isWaitingForInput = false;
let inputResolver = null;

// Syntax Highlighting
function updateHighlight() {
    highlight.textContent = editor.value + (editor.value.endsWith('\n') ? ' ' : '');
    Prism.highlightElement(highlight);
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
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        runCode();
    }
});

// Terminal Output Helper
function printToTerminal(msg, type = 'stdout') {
    const div = document.createElement('div');
    if (type === 'stderr') div.className = 'text-red-400';
    else if (type === 'system') div.className = 'text-blue-400 font-bold';
    else if (type === 'input') div.className = 'text-green-400 font-bold';
    else div.className = 'text-slate-300';
    
    div.textContent = type === 'input' ? `> ${msg}` : msg;
    termOutput.appendChild(div);
    termOutput.scrollTop = termOutput.scrollHeight;
}

// "Unstoppable" Resilience Layer
async function initPython() {
    try {
        pyodide = await loadPyodide({
            indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/",
            stdout: (text) => printToTerminal(text),
            stderr: (text) => printToTerminal(text, 'stderr'),
        });

        await pyodide.loadPackage("micropip");

        // Advanced Resilience Injection to mock problematic system modules
        await pyodide.runPythonAsync(`
import builtins
import sys
import os
import types

# 1. Input Bridge
def custom_input(prompt=""):
    if prompt:
        print(prompt, end="")
    return __js_request_input(prompt)
builtins.input = custom_input

# 2. Subprocess Resilience (The "Unstoppable" Fix)
class MockSubprocess:
    PIPE = -1
    STDOUT = -2
    DEVNULL = -3
    
    class CompletedProcess:
        def __init__(self, args, returncode, stdout=b'', stderr=b''):
            self.args = args
            self.returncode = returncode
            self.stdout = stdout
            self.stderr = stderr
            
    def run(self, args, *args_pos, **kwargs):
        print(f"RESILIENCE NOTE: Intercepted blocked call 'subprocess.run({args})'.", file=sys.stderr)
        return self.CompletedProcess(args, 0, stdout=b'Mocked Output')
        
    def Popen(self, *args, **kwargs):
        # Instead of raising OSError, we provide a dummy that doesn't crash the loop
        print("RESILIENCE NOTE: 'subprocess.Popen' prevented. Spawning dummy process.", file=sys.stderr)
        class DummyProcess:
            def __init__(self):
                self.returncode = 0
                self.stdin = types.SimpleNamespace(write=lambda x: None, close=lambda: None)
                self.stdout = types.SimpleNamespace(read=lambda: b'', close=lambda: None)
                self.stderr = types.SimpleNamespace(read=lambda: b'', close=lambda: None)
            def communicate(self, *a, **k): return (b'', b'')
            def wait(self, *a, **k): return 0
            def poll(self): return 0
            def __enter__(self): return self
            def __exit__(self, *a): pass
        return DummyProcess()

    def check_output(self, *a, **k): return b'Mocked Output'
    def call(self, *a, **k): return 0

sys.modules['subprocess'] = MockSubprocess()

# 3. OS System & Multiprocessing Mocks
def mock_system(cmd):
    print(f"RESILIENCE NOTE: 'os.system' ({cmd}) intercepted. Terminal simulation only.", file=sys.stderr)
    return 0
os.system = mock_system

# Mock multiprocessing to prevent common 'fork' errors
class MockMultiprocessing:
    def cpu_count(self): return 1
    class Process:
        def __init__(self, *a, **k): pass
        def start(self): print("RESILIENCE NOTE: Multiprocessing start() ignored in browser.", file=sys.stderr)
        def join(self, *a): pass
sys.modules['multiprocessing'] = MockMultiprocessing()
        `);

        // Bridge for input()
        window.__js_request_input = async (prompt) => {
            isWaitingForInput = true;
            promptLabel.textContent = prompt || "?";
            promptLabel.classList.add('animate-pulse');
            statusText.textContent = "Awaiting Input...";
            return new Promise(resolve => {
                inputResolver = resolve;
            });
        };

        document.getElementById('loading-overlay').style.opacity = '0';
        setTimeout(() => document.getElementById('loading-overlay').remove(), 500);
        printToTerminal("Unstoppable Resilience Layer Active.", "system");
        updateHighlight();
    } catch (err) {
        printToTerminal(`Core Error: ${err.message}`, 'stderr');
    }
}

// Code Execution
async function runCode() {
    if (!pyodide) return;
    statusText.textContent = "Executing...";
    runBtn.disabled = true;
    runBtn.classList.add('opacity-50');
    printToTerminal("--- Session Started ---", "system");

    try {
        await pyodide.runPythonAsync(editor.value);
    } catch (err) {
        printToTerminal(err.message, 'stderr');
    } finally {
        statusText.textContent = "Ready";
        runBtn.disabled = false;
        runBtn.classList.remove('opacity-50');
        printToTerminal("--- Session Finished ---", "system");
    }
}

// Terminal Logic
async function handleCommand() {
    const cmd = termInput.value.trim();
    if (!cmd && !isWaitingForInput) return;

    if (isWaitingForInput) {
        const val = termInput.value;
        printToTerminal(val, 'input');
        termInput.value = '';
        isWaitingForInput = false;
        promptLabel.textContent = ">>>";
        promptLabel.classList.remove('animate-pulse');
        statusText.textContent = "Executing...";
        inputResolver(val);
        return;
    }

    printToTerminal(cmd, 'input');
    termInput.value = '';

    // Advanced Pip Support
    const pipRegex = /^(!)?pip3?\s+install\s+(.+)$/i;
    const pipMatch = cmd.match(pipRegex);

    if (pipMatch) {
        const pkg = pipMatch[2].trim();
        printToTerminal(`Fetching ${pkg} from PyPI via WASM...`, 'system');
        try {
            const micropip = pyodide.pyimport("micropip");
            await micropip.install(pkg);
            printToTerminal(`Package ${pkg} is now available.`, 'system');
        } catch (err) {
            printToTerminal(`Pip Error: ${err.message}`, 'stderr');
        }
    } else {
        try {
            const result = await pyodide.runPythonAsync(cmd);
            if (result !== undefined && result !== null) {
                printToTerminal(String(result));
            }
        } catch (err) {
            printToTerminal(err.message, 'stderr');
        }
    }
}

// AI Controller
window.askAI = async (action) => {
    aiResponse.textContent = "Gemini AI is processing your request...";
    const code = editor.value;
    
    try {
        let prompt = "";
        if (action === 'explain') {
            prompt = `As an expert Python engineer, explain this code and point out any browser-specific limitations:\n\n${code}`;
        } else if (action === 'fix') {
            const lastError = Array.from(termOutput.children).reverse().find(c => c.classList.contains('text-red-400'))?.textContent || "No current error";
            prompt = `The following code has an issue or error. Error context: ${lastError}. Provide a browser-safe Python fix:\n\n${code}`;
        }

        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: prompt,
        });
        
        aiResponse.textContent = response.text;
    } catch (err) {
        aiResponse.textContent = `AI Error: ${err.message}`;
    }
};

// Listeners
runBtn.addEventListener('click', runCode);
clearBtn.addEventListener('click', () => { termOutput.innerHTML = ''; });
termInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleCommand();
});

// Initialization Call
initPython();
