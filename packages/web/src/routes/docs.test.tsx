import { screen } from '@testing-library/react';
import { DocsPage } from './docs';
import { render } from '@/test/render';

/** #518-followup — 用户指南页面:标题/快速开始/功能总览(来自 features.ts)。 */
describe('DocsPage', () => {
  it('renders guide title, quick start and feature groups', () => {
    render(<DocsPage />);

    expect(screen.getByRole('heading', { name: /user guide/i })).toBeInTheDocument();
    expect(screen.getByText(/quick start/i)).toBeInTheDocument();
    // feature groups from src/docs/features.ts
    expect(screen.getByText('对话')).toBeInTheDocument();
    expect(screen.getByText('患者管理')).toBeInTheDocument();
    expect(screen.getByText('研究与写作')).toBeInTheDocument();
    // a few feature entries
    expect(screen.getByText('通用对话')).toBeInTheDocument();
    expect(screen.getByText('患者列表')).toBeInTheDocument();
    expect(screen.getByText('插件')).toBeInTheDocument();
  });
});
