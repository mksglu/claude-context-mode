### Deno Unit Test Example for Supabase Edge Functions

Source: https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/functions/unit-test.mdx

This TypeScript example demonstrates a unit test for Supabase Edge Functions using Deno. It shows how to initialize a Supabase client with environment variables, test client creation and database connectivity, and invoke an Edge Function to assert its response.

```typescript
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2'
import 'jsr:@std/dotenv/load'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const supabaseKey = Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? ''
const options = {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
}

const testClientCreation = async () => {
  var client: SupabaseClient = createClient(supabaseUrl, supabaseKey, options)
  if (!supabaseUrl) throw new Error('supabaseUrl is required.')
  if (!supabaseKey) throw new Error('supabaseKey is required.')
  const { data: table_data, error: table_error } = await client.from('my_table').select('*').limit(1)
  if (table_error) throw new Error('Invalid Supabase client: ' + table_error.message)
  assert(table_data, 'Data should be returned from the query.')
}

const testHelloWorld = async () => {
  var client: SupabaseClient = createClient(supabaseUrl, supabaseKey, options)
  const { data: func_data, error: func_error } = await client.functions.invoke('hello-world', { body: { name: 'bar' } })
  if (func_error) throw new Error('Invalid response: ' + func_error.message)
  console.log(JSON.stringify(func_data, null, 2))
  assertEquals(func_data.message, 'Hello bar!')
}

Deno.test('Client Creation Test', testClientCreation)
Deno.test('Hello-world Function Test', testHelloWorld)
```

### Connect to Supabase Postgres with supabase-js in Deno Edge Function

Source: https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/functions/connect-to-postgres.mdx

```typescript
import { createClient } from 'npm:@supabase/supabase-js@2'

Deno.serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    )
    const { data, error } = await supabase.from('countries').select('*')
    if (error) throw error
    return new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' }, status: 200 })
  } catch (err) {
    return new Response(String(err?.message ?? err), { status: 500 })
  }
})
```

### Initialize Supabase Client with Auth Context in Deno Edge Function

Source: https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/functions/auth-legacy-jwt.mdx

```typescript
import { createClient } from 'npm:@supabase/supabase-js@2'

Deno.serve(async (req: Request) => {
  const supabaseClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
  );
})
```

### Invoke Live Supabase Edge Function

Source: https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/functions/deploy.mdx

```bash
curl --request POST 'https://<project_id>.supabase.co/functions/v1/hello-world' \
  --header 'Authorization: Bearer ANON_KEY' \
  --header 'Content-Type: application/json' \
  --data '{ "name":"Functions" }'
```

```js
const { data, error } = await supabase.functions.invoke('hello-world', {
  body: { name: 'Functions' },
})
```

### Supabase Edge Functions - Serverless Drivers

Supabase Edge Functions use the Deno runtime which has native support for TCP connections, providing flexibility in choosing your database client. You can use supabase-js, Deno Postgres driver, Postgres.js, or Drizzle ORM.
