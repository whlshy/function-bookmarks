import React, { useState, useEffect, memo, forwardRef } from 'react';
import styled from 'styled-components';

const Title = styled.h1`
  color: red;
  &:hover { color: blue; }
`;

export default function App({ items }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    document.title = `Count: ${items.length}`;
    return () => {
      document.title = '';
    };
  }, [items]);

  const handleClick = (e) => {
    e.preventDefault();
    setOpen(!open);
  };

  function renderItem(item) {
    return <li key={item.id}>{item.name}</li>;
  }

  return (
    <div className="app">
      <Title>Don't panic / it's fine</Title>
      <a href="/docs/start">Docs</a> {/* comment { */}
      <button onClick={() => setOpen(true)}>Open</button>
      <ul>{items.map((item) => renderItem(item))}</ul>
      {open && <Modal onClose={() => { setOpen(false); }} />}
    </div>
  );
}

export const Header = ({ title }) => {
  return <header>{title}</header>;
};

const Footer = () => <footer>© 2026 / all rights</footer>;

export const Card = memo(function Card({ children }) {
  return <div className="card">{children}</div>;
});

export const Input = forwardRef((props, ref) => {
  return <input ref={ref} {...props} />;
});

class Legacy extends React.Component {
  state = { n: 0 };

  handleInc = () => {
    this.setState({ n: this.state.n + 1 });
  };

  componentDidMount() {
    console.log('mounted');
  }

  render() {
    return <span onClick={this.handleInc}>{this.state.n}</span>;
  }
}

function useCounter(initial = 0) {
  const [n, setN] = useState(initial);
  const inc = () => setN((x) => x + 1);
  return { n, inc };
}
