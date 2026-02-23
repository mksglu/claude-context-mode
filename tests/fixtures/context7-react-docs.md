### useEffect Hook Reference

Source: https://react.dev/reference/react/useEffect

The useEffect Hook allows you to declare side effects in functional components. It accepts a setup function and optional dependencies array, running the setup after component commits and cleanup before re-runs or unmounting.

```APIDOC
## useEffect Hook

### Description
A React Hook that synchronizes a component with an external system by running side effects after render commits.

### Syntax
```js
useEffect(setup, dependencies?)
```

### Parameters

#### setup (Function) - Required
The function containing your Effect's logic. May optionally return a cleanup function.
- Runs after component commits to DOM
- Cleanup function runs before re-runs with new dependencies or before component unmounts
- Receives no parameters

#### dependencies (Array) - Optional
List of all reactive values referenced in setup code (props, state, variables, functions declared in component body).
- If omitted: Effect re-runs after every commit
- If empty array `[]`: Effect runs once after initial mount
- If array with values `[dep1, dep2]`: Effect re-runs when dependencies change
- Compared using `Object.is()` comparison
- Must have constant number of items and be written inline

### Returns
`undefined`

### Basic Example
```js
import { useState, useEffect } from 'react';
import { createConnection } from './chat.js';

function ChatRoom({ roomId }) {
  const [serverUrl, setServerUrl] = useState('https://localhost:1234');

  useEffect(() => {
    const connection = createConnection(serverUrl, roomId);
    connection.connect();

    // Cleanup function
    return () => {
      connection.disconnect();
    };
  }, [serverUrl, roomId]);

  return <div>Chat Room</div>;
}
```

### Important Rules

#### Placement
- Call at top level of component or custom Hook
- Cannot call inside loops or conditions
- Extract to new component if conditional Effect needed

#### When to Use
- Synchronizing with external systems
- Do not use if not synchronizing with external system

#### Development Behavior
- Strict Mode runs extra setup+cleanup cycle before first real setup
- Stress-tests that cleanup mirrors setup logic
- Only in development, not in production

#### Performance Considerations
- Object/function dependencies can cause unnecessary re-runs
- Remove unnecessary object and function dependencies
- Extract state updates outside Effect when possible
- Extract non-reactive logic outside Effect

#### Rendering Behavior
- Effects run on client only, not during server rendering
- Non-interaction Effects: browser paints before Effect runs
- Interaction Effects: Effect may run before browser paints
- Use `useLayoutEffect` if visual Effect needs to run before paint
- Use `setTimeout` to defer work until after paint if needed

### Caveats
- Effects only run on client, not during server rendering
- Strict Mode adds extra setup+cleanup cycle in development
- Object/function dependencies may cause excessive re-runs
- Visual Effects may need `useLayoutEffect` instead
- Browser repaint timing depends on Effect cause (interaction vs non-interaction)
```

--------------------------------

### useEffect with External System Connection and Cleanup

Source: https://react.dev/reference/react/useEffect

Shows a practical example of using useEffect to establish a connection to an external system (chat room) with proper cleanup. Demonstrates dependency array usage with serverUrl and roomId, and includes a cleanup function that disconnects when dependencies change or component unmounts.

```javascript
import { useState, useEffect } from 'react';
import { createConnection } from './chat.js';

function ChatRoom({ roomId }) {
  const [serverUrl, setServerUrl] = useState('https://localhost:1234');

  useEffect(() => {
    const connection = createConnection(serverUrl, roomId);
    connection.connect();
    return () => {
      connection.disconnect();
    };
  }, [serverUrl, roomId]);
  // ...
}
```

--------------------------------

### Fetch Data with Cleanup Function in React useEffect

Source: https://react.dev/learn/synchronizing-with-effects

Demonstrates a React useEffect hook that fetches data asynchronously while using a cleanup function to ignore stale responses when dependencies change. The `ignore` flag prevents state updates from outdated requests, ensuring that if the userId changes, previous responses are discarded even if they arrive later.

```javascript
useEffect(() => {
  let ignore = false;

  async function startFetching() {
    const json = await fetchTodos(userId);
    if (!ignore) {
      setTodos(json);
    }
  }

  startFetching();

  return () => {
    ignore = true;
  };
}, [userId]);
```

### Hooks > useEffect > Cleanup and Resource Management

Source: https://react.dev/learn/reusing-logic-with-custom-hooks

Cleanup functions in `useEffect` are essential for preventing memory leaks and managing resources properly. The `useChatRoom` Hook returns a cleanup function that calls `connection.disconnect()`, ensuring that when the component unmounts or before a new effect runs, the previous connection is properly closed. This pattern is crucial when dealing with external resources like WebSocket connections, event listeners, or timers that need to be explicitly released.

--------------------------------

### useEffect > Reference > useEffect(setup, dependencies?)

Source: https://react.dev/reference/react/useEffect

`useEffect` is a React Hook that lets you synchronize a component with an external system. You call `useEffect` at the top level of your component to declare an Effect. The hook accepts a setup function containing your Effect's logic, which may optionally return a cleanup function. When your component commits to the DOM, React will run your setup function. After every commit with changed dependencies, React will first run the cleanup function (if provided) with the old values, and then run your setup function with the new values. After your component is removed from the DOM, React will run your cleanup function.
