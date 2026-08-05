import { describe, test, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolCalls, type ToolCallEntry } from './ToolCalls';

describe('ToolCalls (U2)', () => {
  test('consecutive retrieval calls merge into one foldable row', () => {
    const calls: ToolCallEntry[] = [
      { tool: 'search_node', argsPreview: '{"query":"ZQ"}' },
      { tool: 'search_encounter', argsPreview: '{"query":"fever"}' },
    ];
    render(<ToolCalls calls={calls} />);
    expect(screen.getByText(/检索患者记忆 · 2/)).toBeInTheDocument();
    // details hidden until expanded
    expect(screen.queryByText(/search_node/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/检索患者记忆/));
    expect(screen.getByText(/search_node/)).toBeInTheDocument();
    expect(screen.getByText(/search_encounter/)).toBeInTheDocument();
  });

  test('non-retrieval tools render as their own badges', () => {
    const calls: ToolCallEntry[] = [
      { tool: 'ocr_image', argsPreview: '{}' },
      { tool: 'defer_to_background', argsPreview: '{}' },
    ];
    render(<ToolCalls calls={calls} />);
    expect(screen.getByText('ocr_image')).toBeInTheDocument();
    expect(screen.getByText('defer_to_background')).toBeInTheDocument();
  });

  test('retrieval then action breaks the group', () => {
    const calls: ToolCallEntry[] = [
      { tool: 'search_node', argsPreview: '{}' },
      { tool: 'ocr_image', argsPreview: '{}' },
      { tool: 'search_encounter', argsPreview: '{}' },
    ];
    render(<ToolCalls calls={calls} />);
    expect(screen.getAllByText(/检索患者记忆/)).toHaveLength(2);
    expect(screen.getByText('ocr_image')).toBeInTheDocument();
  });

  test('empty calls render nothing', () => {
    const { container } = render(<ToolCalls calls={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
