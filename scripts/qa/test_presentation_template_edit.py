"""Regression tests for single-page content editing; no customer fixtures."""
import sys
import unittest
from copy import deepcopy
from pathlib import Path
from xml.etree import ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'resources/skills/ppt-master/scripts'))
from neoworker_template_fill import _replacement_plan, build_plan
from template_fill_pptx.text_fill import _set_container_text
from template_fill_pptx.ooxml import NS


def slot(i, role, text, height=40, width=240):
    return dict(slot_id=f's01_sh{i}', role=role, text=text,
                geometry=dict(width=width, height=height), text_metrics=dict(font_size_px=20))


def report_slide():
    return dict(slide_index=1, page_type='cover_candidate', slots=[
        slot(1, 'title_candidate', 'Original title'),
        *[slot(i, 'subtitle_candidate', f'{i} original KPI') for i in range(2, 6)],
        slot(6, 'label_candidate', 'Original body', 400, 1000),
    ])


class TemplateEditTests(unittest.TestCase):
    def test_body_is_written_once_and_not_into_kpis(self):
        plan = _replacement_plan(report_slide(), dict(title='New title', subtitle='Summary', content=['Progress', 'Risk']), True)
        self.assertEqual([p['slot_id'] for p in plan], ['s01_sh1', 's01_sh6'])
        self.assertEqual(plan[1]['text'], 'Summary\nProgress\nRisk')

    def test_new_template_fill_does_not_repeat_subtitle(self):
        plan = _replacement_plan(report_slide(), dict(title='New', subtitle='Summary', content=['Body']))
        self.assertEqual(sum(p['text'].count('Summary') for p in plan), 1)
        self.assertEqual(sum(p['text'].count('Body') for p in plan), 1)

    def test_partial_explicit_edit_preserves_every_other_shape(self):
        plan = _replacement_plan(report_slide(), dict(title='Ignored', content=['Ignored'], templateReplacements=[dict(shapeId='6', text='Optimized body')]), True)
        self.assertEqual(plan, [dict(slot_id='s01_sh6', old_text='Original body', text='Optimized body')])

    def test_invalid_shape_is_not_silently_ignored(self):
        for edits in [[dict(shapeId='99', text='x')], [dict(shapeId='6', text='x')]*2, []]:
            with self.assertRaises(RuntimeError):
                _replacement_plan(report_slide(), dict(templateReplacements=edits), True)

    def test_page_expansion_rejected_before_writing(self):
        with self.assertRaisesRegex(RuntimeError, 'original 1 slide'):
            build_plan(dict(slides=[report_slide()]), [dict(title='x')]*7, True)

    def test_edit_uses_original_order_even_when_model_changes_role(self):
        first=report_slide(); second=deepcopy(first);second['slide_index']=2;second['page_type']='content_candidate'
        plan=build_plan(dict(slides=[first,second]), [dict(title='A'),dict(title='B',slideType='cover')], True)
        self.assertEqual([s['source_slide'] for s in plan['slides']], [1,2])

    def test_explicit_restructure_still_supported(self):
        plan=build_plan(dict(slides=[report_slide()]), [dict(title='x',content=['Body'])]*7)
        self.assertEqual(len(plan['slides']),7)

    def test_empty_sample_paragraphs_removed_and_added_lines_are_native(self):
        shape=ET.fromstring('<p:sp xmlns:p="'+NS['p']+'" xmlns:a="'+NS['a']+'"><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1200"/><a:t>old</a:t></a:r></a:p><a:p><a:r><a:t>sample</a:t></a:r></a:p></p:txBody></p:sp>')
        _set_container_text(shape,'one')
        self.assertEqual(len(shape.findall('.//a:p', NS)),1)
        _set_container_text(shape,'one\ntwo\nthree')
        self.assertEqual(len(shape.findall('.//a:p', NS)),3)
        self.assertEqual([n.text for n in shape.findall('.//a:t',NS)],['one','two','three'])

    def test_unchanged_kpi_keeps_number_unit_and_label_runs(self):
        shape=ET.fromstring('<p:sp xmlns:p="'+NS['p']+'" xmlns:a="'+NS['a']+'"><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="2200"/><a:t>14</a:t></a:r><a:r><a:rPr sz="1100"/><a:t> projects</a:t></a:r></a:p></p:txBody></p:sp>')
        before=ET.tostring(shape)
        _set_container_text(shape,'14 projects')
        self.assertEqual(ET.tostring(shape),before)

if __name__ == '__main__': unittest.main()
