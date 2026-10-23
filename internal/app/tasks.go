package app

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

type Task struct {
	ID        string `json:"id"`
	NotePath  string `json:"notePath"`
	NoteTitle string `json:"noteTitle"`
	Line      int    `json:"line"`
	Text      string `json:"text"`
	Status    string `json:"status"`
	Due       string `json:"due,omitempty"`
	RemindAt  string `json:"remindAt,omitempty"`
	Repeat    string `json:"repeat,omitempty"`
	Timezone  string `json:"timezone,omitempty"`
	Revision  string `json:"revision"`
}
type taskMeta struct {
	ID        string `json:"id"`
	Status    string `json:"status"`
	Due       string `json:"due,omitempty"`
	RemindAt  string `json:"remindAt,omitempty"`
	Repeat    string `json:"repeat,omitempty"`
	Timezone  string `json:"timezone,omitempty"`
	AnchorDay int    `json:"anchorDay,omitempty"`
}
type TaskUpdate struct {
	NotePath string  `json:"notePath"`
	Line     int     `json:"line"`
	ID       string  `json:"id"`
	Revision string  `json:"revision"`
	Status   *string `json:"status"`
	Due      *string `json:"due"`
	RemindAt *string `json:"remindAt"`
	Repeat   *string `json:"repeat"`
	Timezone *string `json:"timezone"`
}
type Reminder struct {
	ID           string `json:"id"`
	TaskID       string `json:"taskId"`
	NotePath     string `json:"notePath"`
	Text         string `json:"text"`
	Due          string `json:"due"`
	Acknowledged bool   `json:"acknowledged"`
}

var taskLine = regexp.MustCompile(`^(\s*(?:[-+*]|\d+[.)])\s+\[)([ xX])(\]\s+)(.*)$`)
var taskComment = regexp.MustCompile(`\s*<!--\s*echo-task:\s*(\{.*?\})\s*-->`)

func parseTasks(note Note) []Task {
	tasks := []Task{}
	_, body, offset, _ := frontmatter(note.Content)
	ignoredLines := map[int]bool{}
	source := []byte(body)
	document := goldmark.DefaultParser().Parse(text.NewReader(source))
	_ = ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		if node.Kind() != ast.KindCodeBlock && node.Kind() != ast.KindFencedCodeBlock && node.Kind() != ast.KindHTMLBlock {
			return ast.WalkContinue, nil
		}
		for i := 0; i < node.Lines().Len(); i++ {
			segment := node.Lines().At(i)
			start := strings.Count(body[:segment.Start], "\n") + offset
			stop := segment.Stop
			if stop > segment.Start {
				stop--
			}
			end := strings.Count(body[:stop], "\n") + offset
			for line := start; line <= end; line++ {
				ignoredLines[line] = true
			}
		}
		return ast.WalkSkipChildren, nil
	})
	lines := strings.Split(note.Content, "\n")
	fence := ""
	fenceLen := 0
	for index, line := range lines {
		if index < offset {
			continue
		}
		if ignoredLines[index] {
			continue
		}
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "```") || strings.HasPrefix(trim, "~~~") {
			char := trim[:1]
			count := 0
			for count < len(trim) && trim[count:count+1] == char {
				count++
			}
			if fence == "" {
				fence = char
				fenceLen = count
			} else if char == fence && count >= fenceLen {
				fence = ""
			}
			continue
		}
		if fence != "" {
			continue
		}
		match := taskLine.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		meta := taskMeta{}
		if comment := taskComment.FindStringSubmatch(match[4]); comment != nil {
			_ = json.Unmarshal([]byte(comment[1]), &meta)
		}
		text := strings.TrimSpace(taskComment.ReplaceAllString(match[4], ""))
		if meta.ID == "" {
			meta.ID = revision([]byte(fmt.Sprintf("%s:%d:%s", note.Path, index+1, text)))[:24]
		}
		status := meta.Status
		if status != "doing" {
			status = "todo"
		}
		if match[2] != " " {
			status = "done"
		}
		tasks = append(tasks, Task{ID: meta.ID, NotePath: note.Path, NoteTitle: note.Title, Line: index + 1, Text: text, Status: status, Due: meta.Due, RemindAt: meta.RemindAt, Repeat: meta.Repeat, Timezone: meta.Timezone, Revision: note.Revision})
	}
	return tasks
}
func (s *Store) allTasks() ([]Task, error) {
	notes, err := s.listNotes()
	if err != nil {
		return nil, err
	}
	tasks := []Task{}
	for _, note := range notes {
		tasks = append(tasks, parseTasks(note)...)
	}
	return tasks, nil
}

func parseTaskTime(value, timezone string) (time.Time, error) {
	location := time.Local
	if timezone != "" {
		var err error
		location, err = time.LoadLocation(timezone)
		if err != nil {
			return time.Time{}, fmt.Errorf("无效时区: %s", timezone)
		}
	}
	if value == "" {
		return time.Time{}, nil
	}
	if t, err := time.Parse(time.RFC3339, value); err == nil {
		return t.In(location), nil
	}
	for _, layout := range []string{"2006-01-02T15:04", "2006-01-02 15:04", "2006-01-02"} {
		if t, err := time.ParseInLocation(layout, value, location); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("无效任务日期: %s", value)
}
func nextOccurrence(due time.Time, repeat string, anchor int, now time.Time) time.Time {
	next := due
	if anchor == 0 {
		anchor = due.Day()
	}
	for i := 0; i < 100000; i++ {
		switch repeat {
		case "daily":
			next = next.AddDate(0, 0, 1)
		case "weekly":
			next = next.AddDate(0, 0, 7)
		case "monthly":
			month := time.Date(next.Year(), next.Month()+1, 1, next.Hour(), next.Minute(), next.Second(), next.Nanosecond(), next.Location())
			last := time.Date(month.Year(), month.Month()+1, 0, 0, 0, 0, 0, month.Location()).Day()
			day := anchor
			if day > last {
				day = last
			}
			next = time.Date(month.Year(), month.Month(), day, next.Hour(), next.Minute(), next.Second(), next.Nanosecond(), next.Location())
		default:
			return next
		}
		if next.After(now) {
			return next
		}
	}
	return next
}
func (s *Store) updateTask(update TaskUpdate) (Note, error) {
	note, err := s.readNote(update.NotePath)
	if err != nil {
		return Note{}, err
	}
	if update.Revision != note.Revision {
		return Note{}, &Conflict{Current: note}
	}
	var selected *Task
	for _, task := range parseTasks(note) {
		if (update.ID != "" && task.ID == update.ID) || (update.ID == "" && task.Line == update.Line) {
			copy := task
			selected = &copy
			break
		}
	}
	if selected == nil {
		return Note{}, fmt.Errorf("任务已不存在，请刷新")
	}
	lines := strings.Split(note.Content, "\n")
	index := selected.Line - 1
	match := taskLine.FindStringSubmatch(lines[index])
	meta := taskMeta{}
	if comment := taskComment.FindStringSubmatch(lines[index]); comment != nil {
		if err = json.Unmarshal([]byte(comment[1]), &meta); err != nil {
			return Note{}, fmt.Errorf("任务元数据无效，请修复源码")
		}
	}
	meta.ID = selected.ID
	meta.Status = selected.Status
	if update.Status != nil {
		if *update.Status != "todo" && *update.Status != "doing" && *update.Status != "done" {
			return Note{}, fmt.Errorf("无效任务状态")
		}
		meta.Status = *update.Status
	}
	if update.Timezone != nil {
		meta.Timezone = *update.Timezone
	}
	if meta.Timezone == "" {
		meta.Timezone = "Local"
	}
	if update.Due != nil {
		meta.Due = *update.Due
		meta.AnchorDay = 0
	}
	if update.RemindAt != nil {
		meta.RemindAt = *update.RemindAt
	}
	if update.Repeat != nil {
		meta.Repeat = *update.Repeat
	}
	if meta.Repeat != "" && meta.Repeat != "none" && meta.Repeat != "daily" && meta.Repeat != "weekly" && meta.Repeat != "monthly" {
		return Note{}, fmt.Errorf("无效重复规则")
	}
	due, err := parseTaskTime(meta.Due, meta.Timezone)
	if err != nil {
		return Note{}, err
	}
	remind, err := parseTaskTime(meta.RemindAt, meta.Timezone)
	if err != nil {
		return Note{}, err
	}
	if meta.Repeat != "" && meta.Repeat != "none" && due.IsZero() {
		return Note{}, fmt.Errorf("重复任务需要设置到期时间")
	}
	oldHistory := len(s.state.History)
	if meta.Status == "done" && selected.Status != "done" {
		s.state.History = append(s.state.History, HistoryEntry{TaskID: meta.ID, NotePath: note.Path, Due: meta.Due, CompletedAt: time.Now().UTC().Format(time.RFC3339Nano)})
		if meta.Repeat != "" && meta.Repeat != "none" && !due.IsZero() {
			if meta.AnchorDay == 0 {
				meta.AnchorDay = due.Day()
			}
			next := nextOccurrence(due, meta.Repeat, meta.AnchorDay, time.Now())
			if !remind.IsZero() {
				meta.RemindAt = next.Add(remind.Sub(due)).Format(time.RFC3339)
			}
			meta.Due = next.Format(time.RFC3339)
			meta.Status = "todo"
		}
	}
	check := " "
	if meta.Status == "done" {
		check = "x"
	}
	encoded, _ := json.Marshal(meta)
	lines[index] = match[1] + check + match[3] + strings.TrimSpace(taskComment.ReplaceAllString(match[4], "")) + " <!-- echo-task: " + string(encoded) + " -->"
	result, err := s.saveNote(note.Path, strings.Join(lines, "\n"), note.Revision, false)
	if err != nil {
		s.state.History = s.state.History[:oldHistory]
		return Note{}, err
	}
	if err = s.persist(); err != nil {
		s.state.History = s.state.History[:oldHistory]
		_, _ = s.saveNote(note.Path, note.Content, result.Revision, false)
		return Note{}, err
	}
	return result, nil
}
func (s *Store) checkReminders(now time.Time) {
	if _, err := os.Stat(s.journalPath()); err == nil {
		return
	}
	tasks, err := s.allTasks()
	if err != nil {
		return
	}
	seen := map[string]bool{}
	for _, reminder := range s.state.Reminders {
		seen[reminder.ID] = true
	}
	oldCount := len(s.state.Reminders)
	for _, task := range tasks {
		if task.Status == "done" {
			continue
		}
		value := task.RemindAt
		if value == "" {
			value = task.Due
		}
		if value == "" {
			continue
		}
		due, err := parseTaskTime(value, task.Timezone)
		if err != nil || due.After(now) {
			continue
		}
		id := revision([]byte(task.ID + ":" + value))[:24]
		if seen[id] {
			continue
		}
		s.state.Reminders = append(s.state.Reminders, Reminder{ID: id, TaskID: task.ID, NotePath: task.NotePath, Text: task.Text, Due: due.UTC().Format(time.RFC3339), Acknowledged: false})
		seen[id] = true
	}
	if len(s.state.Reminders) > oldCount {
		if err = s.persist(); err != nil {
			s.state.Reminders = s.state.Reminders[:oldCount]
			return
		}
		for _, reminder := range s.state.Reminders[oldCount:] {
			s.publish(map[string]any{"type": "reminder", "reminder": reminder})
		}
	}
}
