---
title: 'Markdown Style Guide'
description: 'A comprehensive sample of Markdown syntax and rendering for portfolio documentation.'
pubDate: 'Jun 19 2024'
heroImage: '../../assets/blog-placeholder-about.jpg'
---

Here is a sample of basic Markdown syntax used when writing content for the blog.

## Typography and Text Elements

Paragraphs can contain **bold text**, *italic text*, and `inline code elements`. 

### Unordered Lists

* Enterprise platforms
* Cloud workflows
* Agent integrations

### Code Blocks

```python
from fastmcp import FastMCP

mcp = FastMCP("sensing-service")

@mcp.tool()
def query_pipeline_signals(pipeline_id: str) -> dict:
    """Retrieve operational telemetry for a given sensing pipeline."""
    return {"pipeline_id": pipeline_id, "status": "active"}
```
