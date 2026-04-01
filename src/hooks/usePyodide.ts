import { useState, useEffect, useCallback } from 'react';

declare global {
  interface Window {
    loadPyodide: any;
  }
}

export function usePyodide() {
  const [pyodide, setPyodide] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadPyodideInstance = async () => {
      try {
        if (!window.loadPyodide) {
          const script = document.createElement('script');
          script.src = 'https://cdn.jsdelivr.net/pyodide/v0.23.4/full/pyodide.js';
          script.async = true;
          script.onload = async () => {
            const instance = await window.loadPyodide();
            setPyodide(instance);
            setIsLoading(false);
          };
          document.head.appendChild(script);
        } else {
          const instance = await window.loadPyodide();
          setPyodide(instance);
          setIsLoading(false);
        }
      } catch (err) {
        console.error('Failed to load Pyodide:', err);
        setError('Failed to load Python environment.');
        setIsLoading(false);
      }
    };

    loadPyodideInstance();
  }, []);

  const runCode = useCallback(async (code: string) => {
    if (!pyodide) return { output: '', error: 'Python environment not ready.' };

    try {
      // Redirect stdout and stderr to capture all output
      await pyodide.runPythonAsync(`
import sys
import io
sys.stdout = io.StringIO()
sys.stderr = io.StringIO()
      `);
      
      try {
        await pyodide.runPythonAsync(code);
      } catch (err: any) {
        // If execution fails, we still want to capture what was printed to stdout before the crash
        const stdout = await pyodide.runPythonAsync('sys.stdout.getvalue()');
        const stderr = await pyodide.runPythonAsync('sys.stderr.getvalue()');
        return { 
          output: stdout, 
          error: stderr || err.message,
          isException: true 
        };
      }
      
      const stdout = await pyodide.runPythonAsync('sys.stdout.getvalue()');
      const stderr = await pyodide.runPythonAsync('sys.stderr.getvalue()');
      
      return { 
        output: stdout, 
        error: stderr || null,
        isException: !!stderr
      };
    } catch (err: any) {
      return { output: '', error: err.message, isException: true };
    }
  }, [pyodide]);

  const lintCode = useCallback(async (code: string) => {
    if (!pyodide || !code.trim()) return [];

    try {
      // Define the helper function if it doesn't exist
      await pyodide.runPythonAsync(`
if 'check_syntax' not in globals():
    def check_syntax(code):
        try:
            compile(code, '<string>', 'exec')
            return None
        except SyntaxError as e:
            return {
                "line": e.lineno,
                "column": e.offset,
                "message": str(e.msg),
                "type": "error"
            }
        except Exception as e:
            return {
                "line": 1,
                "column": 1,
                "message": str(e),
                "type": "error"
            }
      `);
      
      pyodide.globals.set("code_to_check", code);
      const result = await pyodide.runPythonAsync(`check_syntax(code_to_check)`);
      
      if (result) {
        const error = typeof result.toJs === 'function' ? result.toJs() : result;
        return [error];
      }
      return [];
    } catch (err) {
      console.error("Linting error:", err);
      return [];
    }
  }, [pyodide]);

  return { runCode, lintCode, isLoading, error };
}
