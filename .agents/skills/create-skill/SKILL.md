---
name: create-skill
description: Guide for creating effective skills following best practices. Use when creating or updating skills that extend agent capabilities.
---

# Create Skill

Guide for creating effective skills that extend agent capabilities with specialized knowledge, workflows, and tool integrations.

## About Skills

Skills are modular, self-contained packages that extend agent capabilities by providing specialized knowledge, workflows, and tools. Think of them as "onboarding guides" for specific domains or tasks.

### What Skills Provide

1. Specialized workflows - Multi-step procedures for specific domains
2. Tool integrations - Instructions for working with specific file formats or APIs
3. Domain expertise - Company-specific knowledge, schemas, business logic
4. Bundled resources - Scripts, references, and assets for complex and repetitive tasks

## Progressive Disclosure Principle

**The 200-line rule is critical.** SKILL.md must be under 200 lines. If you need more, split content into `references/` files.

### Three-Level Loading System

1. **Metadata (name + description)** - Always in context (~100 words)
2. **SKILL.md body** - When skill triggers (<200 lines, ideally <500 lines for optimal performance)
3. **Bundled resources** - As needed by agent (unlimited)

### Why Progressive Disclosure Matters

- 85% reduction in initial context load
- Activation times drop from 500ms+ to under 100ms
- Agent loads only what's needed, when it's needed
- Skills remain maintainable and focused

## Skill Structure

```
skill-name/
├── SKILL.md (required, <200 lines)
│   ├── YAML frontmatter metadata (required)
│   │   ├── name: (required)
│   │   └── description: (required)
│   └── Markdown instructions (required)
└── Bundled Resources (optional)
    ├── scripts/          - Executable code
    ├── references/       - Documentation loaded as needed
    └── assets/           - Files used in output
```

## Core Principles

### Concise is Key

The context window is a shared resource. Your skill shares it with everything else the agent needs. Be concise and challenge each piece of information:
- Does the agent really need this explanation?
- Can I assume the agent knows this?
- Does this paragraph justify its token cost?

### Set Appropriate Degrees of Freedom

- **High freedom**: Text-based instructions for multiple valid approaches
- **Medium freedom**: Pseudocode or scripts with parameters
- **Low freedom**: Specific scripts with few/no parameters for fragile operations

### Test with All Models

Skills act as additions to models, so effectiveness depends on the underlying model. Test your skill with all models you plan to use it with.

## References

For detailed guidance, see:
- `references/progressive-disclosure.md` - 200-line rule and references pattern
- `references/skill-structure.md` - SKILL.md format and frontmatter details
- `references/examples.md` - Good skill examples
- `references/best-practices.md` - Comprehensive best practices guide
