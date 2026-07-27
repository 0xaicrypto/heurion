import { screen } from '@testing-library/react';
import { MemoryPage } from './memory';
import { SidecarPage } from './sidecar';
import { KnowledgeLandingPage } from './knowledge-landing';
import { SecurityPage } from './security';
import { render } from '@/test/render';

describe('Marketing subpages', () => {
  it('MemoryPage explains four layers and projection', () => {
    render(<MemoryPage />);
    expect(screen.getByRole('heading', { name: /four-layer memory/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /raw input/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /time decay keeps memory focused/i })).toBeInTheDocument();
  });

  it('SidecarPage lists supported outputs and workflow', () => {
    render(<SidecarPage />);
    expect(screen.getByRole('heading', { name: /medsci-sidecar/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /supported outputs/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /intent recognition/i })).toBeInTheDocument();
  });

  it('KnowledgeLandingPage shows tabs and evolution flow', () => {
    render(<KnowledgeLandingPage />);
    expect(screen.getByRole('heading', { name: /evolving knowledge base/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /five tabs/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /evolution from facts to articles/i })).toBeInTheDocument();
  });

  it('SecurityPage highlights two-plane isolation', () => {
    render(<SecurityPage />);
    expect(screen.getByRole('heading', { name: /security & isolation architecture/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /two-plane isolation/i })).toBeInTheDocument();
  });
});
