package app

import (
	"bytes"
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

type Metadata struct {
	Tags  []string `json:"tags"`
	Group string   `json:"group"`
}

func normalizeNames(names []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name != "" && !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	return out
}

func frontmatter(content string) (header string, body string, offset int, err error) {
	content = strings.TrimPrefix(content, "\ufeff")
	lines := strings.SplitAfter(content, "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return "", content, 0, nil
	}
	pos := len(lines[0])
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" || strings.TrimSpace(lines[i]) == "..." {
			return content[len(lines[0]):pos], content[pos+len(lines[i]):], i + 1, nil
		}
		pos += len(lines[i])
	}
	return "", content, 0, fmt.Errorf("YAML 文件头缺少结束标记 ---")
}

func readMetadata(content string) (Metadata, error) {
	meta := Metadata{Tags: []string{}}
	header, _, _, err := frontmatter(content)
	if err != nil || header == "" {
		return meta, err
	}
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(header), &doc); err != nil {
		return meta, fmt.Errorf("YAML 文件头无效: %w", err)
	}
	var checked any
	if err := doc.Decode(&checked); err != nil {
		return meta, fmt.Errorf("YAML 文件头无效: %w", err)
	}
	if len(doc.Content) == 0 {
		return meta, nil
	}
	if doc.Content[0].Kind != yaml.MappingNode {
		return meta, fmt.Errorf("YAML 文件头必须是键值对象")
	}
	echo := mappingGet(doc.Content[0], "echo")
	if echo == nil {
		return meta, nil
	}
	if echo.Kind != yaml.MappingNode {
		return meta, fmt.Errorf("echo 元数据必须是键值对象")
	}
	if tags := mappingGet(echo, "tags"); tags != nil {
		if tags.Kind != yaml.SequenceNode {
			return meta, fmt.Errorf("echo.tags 必须是标签数组")
		}
		if err := tags.Decode(&meta.Tags); err != nil {
			return meta, err
		}
	}
	if group := mappingGet(echo, "group"); group != nil {
		if group.Kind != yaml.ScalarNode || group.Tag != "!!str" {
			return meta, fmt.Errorf("echo.group 必须是文本")
		}
		meta.Group = strings.TrimSpace(group.Value)
	}
	meta.Tags = normalizeNames(meta.Tags)
	return meta, nil
}

func mappingGet(node *yaml.Node, name string) *yaml.Node {
	for i := 0; i+1 < len(node.Content); i += 2 {
		if node.Content[i].Value == name {
			return node.Content[i+1]
		}
	}
	return nil
}
func mappingSet(node *yaml.Node, name string, value *yaml.Node) {
	for i := 0; i+1 < len(node.Content); i += 2 {
		if node.Content[i].Value == name {
			node.Content[i+1] = value
			return
		}
	}
	node.Content = append(node.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: name}, value)
}
func writeMetadata(content string, meta Metadata) (string, error) {
	header, body, _, err := frontmatter(content)
	if err != nil {
		return "", err
	}
	var doc yaml.Node
	if header != "" {
		if err := yaml.Unmarshal([]byte(header), &doc); err != nil {
			return "", fmt.Errorf("YAML 文件头无效: %w", err)
		}
		var checked any
		if err := doc.Decode(&checked); err != nil {
			return "", fmt.Errorf("YAML 文件头无效: %w", err)
		}
	}
	if len(doc.Content) == 0 {
		doc = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}}}
	}
	root := doc.Content[0]
	if root.Kind != yaml.MappingNode {
		return "", fmt.Errorf("YAML 文件头必须是键值对象")
	}
	echo := mappingGet(root, "echo")
	if echo == nil {
		echo = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		mappingSet(root, "echo", echo)
	}
	if echo.Kind != yaml.MappingNode {
		return "", fmt.Errorf("echo 元数据必须是键值对象")
	}
	tags := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
	for _, tag := range normalizeNames(meta.Tags) {
		tags.Content = append(tags.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: tag})
	}
	mappingSet(echo, "tags", tags)
	mappingSet(echo, "group", &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: strings.TrimSpace(meta.Group)})
	var out bytes.Buffer
	enc := yaml.NewEncoder(&out)
	enc.SetIndent(2)
	if err := enc.Encode(&doc); err != nil {
		return "", err
	}
	_ = enc.Close()
	return "---\n" + out.String() + "---\n" + body, nil
}
