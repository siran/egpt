import { useEffect, useRef } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';

const placeholderCompartment = new Compartment();

export default function Input({ onSubmit, activeSession }) {
  const containerRef = useRef(null);
  const viewRef = useRef(null);
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  useEffect(() => {
    if (!containerRef.current) return;

    const submit = (view) => {
      const text = view.state.doc.toString();
      if (!text.trim()) return false;
      onSubmitRef.current(text);
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } });
      return true;
    };

    const view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          history(),
          placeholderCompartment.of(placeholder('message…')),
          keymap.of([
            { key: 'Enter', run: submit },
            { key: 'Shift-Enter', run: v => {
              v.dispatch(v.state.replaceSelection('\n'));
              return true;
            }},
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.lineWrapping,
        ],
      }),
      parent: containerRef.current,
    });

    viewRef.current = view;
    view.focus();
    return () => view.destroy();
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const hint = activeSession
      ? `message to @${activeSession}   (Shift+Enter for newline)`
      : 'type a message or /command   (Shift+Enter for newline)';
    view.dispatch({ effects: placeholderCompartment.reconfigure(placeholder(hint)) });
  }, [activeSession]);

  return <div ref={containerRef} />;
}
