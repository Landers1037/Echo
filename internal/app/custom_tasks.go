package app

import (
	"fmt"
	"strings"
	"time"
)

type CustomTask struct {
	ID          string `json:"id"`
	Text        string `json:"text"`
	Description string `json:"description,omitempty"`
	Status      string `json:"status"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

func validTaskStatus(status string) bool {
	return status == "todo" || status == "doing" || status == "done"
}

func (s *Store) createCustomTask(input CustomTask) (CustomTask, error) {
	input.Text = strings.TrimSpace(input.Text)
	input.Description = strings.TrimSpace(input.Description)
	if input.Text == "" {
		return CustomTask{}, fmt.Errorf("任务内容不能为空")
	}
	if input.Status == "" {
		input.Status = "todo"
	}
	if !validTaskStatus(input.Status) {
		return CustomTask{}, fmt.Errorf("无效任务状态")
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	input.ID = newID()
	input.CreatedAt = now
	input.UpdatedAt = now
	old := append([]CustomTask{}, s.state.CustomTasks...)
	s.state.CustomTasks = append(s.state.CustomTasks, input)
	if err := s.persist(); err != nil {
		s.state.CustomTasks = old
		return CustomTask{}, err
	}
	return input, nil
}

func (s *Store) updateCustomTask(input CustomTask) (CustomTask, error) {
	index := -1
	for i := range s.state.CustomTasks {
		if input.ID != "" && s.state.CustomTasks[i].ID == input.ID {
			index = i
			break
		}
	}
	if index < 0 {
		return CustomTask{}, fmt.Errorf("任务不存在")
	}
	input.Text = strings.TrimSpace(input.Text)
	input.Description = strings.TrimSpace(input.Description)
	if input.Text == "" {
		return CustomTask{}, fmt.Errorf("任务内容不能为空")
	}
	if !validTaskStatus(input.Status) {
		return CustomTask{}, fmt.Errorf("无效任务状态")
	}
	current := s.state.CustomTasks[index]
	input.CreatedAt = current.CreatedAt
	input.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	old := append([]CustomTask{}, s.state.CustomTasks...)
	s.state.CustomTasks[index] = input
	if err := s.persist(); err != nil {
		s.state.CustomTasks = old
		return CustomTask{}, err
	}
	return input, nil
}

func (s *Store) deleteCustomTask(id string) error {
	next := make([]CustomTask, 0, len(s.state.CustomTasks))
	found := false
	for _, task := range s.state.CustomTasks {
		if task.ID == id {
			found = true
			continue
		}
		next = append(next, task)
	}
	if !found {
		return fmt.Errorf("任务不存在")
	}
	old := s.state.CustomTasks
	s.state.CustomTasks = next
	if err := s.persist(); err != nil {
		s.state.CustomTasks = old
		return err
	}
	return nil
}
